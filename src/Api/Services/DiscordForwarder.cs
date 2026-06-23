using System.Collections.Concurrent;
using System.Threading.Channels;
using Ccusage.Api.Data;
using Microsoft.EntityFrameworkCore;

namespace Ccusage.Api.Services;

/// <summary>
/// A request describing ONE per-user Discord forward. Carries only the recipient email + the notification
/// metadata — never the webhook URL in plaintext (that is decrypted in-memory at send time) and never any
/// secret. Enqueued at the fan-out hook; drained off the request path by <see cref="DiscordForwarder"/>.
///
/// <para><paramref name="WebhookOverrideEnc"/> is an OPTIONAL AES-GCM encrypted webhook blob (an automation
/// rule's own webhook). When present, the worker decrypts + Discord-allowlist-validates it and posts THERE,
/// bypassing the recipient's per-user webhook/SurfaceDiscord gate (the rule webhook is its own opt-in). When
/// null, the worker resolves the recipient's per-user webhook as before. The per-user rate-limit bucket
/// (keyed on <paramref name="RecipientEmail"/>) applies either way, so a rule can't bypass the spam cap.</para>
/// </summary>
public readonly record struct DiscordForwardItem(
    string RecipientEmail, string Kind, string? ActorName, string Text, string? Link,
    string? WebhookOverrideEnc = null);

/// <summary>
/// Off-request-path, fire-and-forget forwarder of per-user in-app notifications to each user's PERSONAL
/// Discord webhook. Registered as a singleton hosted service. The fan-out path enqueues an item and returns
/// immediately — forwarding NEVER blocks, slows, or fails notification creation. The worker:
///   1. reads the recipient's <c>NotificationPreference</c>, and only proceeds if SurfaceDiscord is on AND a
///      webhook is stored; decrypts the URL via <see cref="TokenProtector"/> in-memory only;
///   2. rate-limits per user (a simple token bucket) so one user can't be used to spam Discord;
///   3. respects a Discord 429 retry-after and drops the item on repeated failure;
///   4. swallows ALL errors and logs metadata only (recipient + event type + ok/failed) — never the URL,
///      never the message text.
/// </summary>
public sealed class DiscordForwarder(
    IServiceScopeFactory scopeFactory, ILogger<DiscordForwarder> logger) : BackgroundService
{
    // Bounded so a flood drops the OLDEST queued forward rather than growing unbounded; the in-app
    // notification itself is already persisted, so a dropped forward only misses the Discord mirror.
    private readonly Channel<DiscordForwardItem> _channel =
        Channel.CreateBounded<DiscordForwardItem>(new BoundedChannelOptions(2048)
        {
            FullMode = BoundedChannelFullMode.DropOldest,
            SingleReader = true,
        });

    // Per-user token bucket: capacity tokens, refilled 1 per RefillSeconds. Caps a single user's forwards.
    private const int BucketCapacity = 20;
    private const double RefillSeconds = 3.0; // ~20 burst then 1 every 3s
    private readonly ConcurrentDictionary<string, TokenBucket> _buckets = new(StringComparer.Ordinal);

    /// <summary>
    /// Enqueue a fire-and-forget forward. Returns immediately; never throws. If the queue is full the
    /// oldest pending item is dropped (the persisted in-app notification is unaffected).
    /// </summary>
    public void Enqueue(DiscordForwardItem item)
    {
        // TryWrite on a DropOldest bounded channel never blocks and effectively always "succeeds".
        _channel.Writer.TryWrite(item);
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        await foreach (var item in _channel.Reader.ReadAllAsync(stoppingToken))
        {
            try { await ForwardOneAsync(item, stoppingToken); }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { break; }
            catch (Exception ex)
            {
                // Metadata-only: recipient + event type, never the URL or message text.
                logger.LogWarning(ex, "Discord forward failed for {Recipient} ({Kind}).",
                    item.RecipientEmail, item.Kind);
            }
        }
    }

    private async Task ForwardOneAsync(DiscordForwardItem item, CancellationToken ct)
    {
        // Per-user rate limit BEFORE touching the DB / Discord.
        var bucket = _buckets.GetOrAdd(item.RecipientEmail, _ => new TokenBucket(BucketCapacity, RefillSeconds));
        if (!bucket.TryTake())
        {
            logger.LogInformation("Dropping Discord forward for {Recipient} ({Kind}): per-user rate limit.",
                item.RecipientEmail, item.Kind);
            return;
        }

        using var scope = scopeFactory.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<UsageDbContext>();
        var protector = scope.ServiceProvider.GetRequiredService<TokenProtector>();
        var notifier = scope.ServiceProvider.GetRequiredService<DiscordNotifier>();

        string? url;
        if (!string.IsNullOrEmpty(item.WebhookOverrideEnc))
        {
            // Per-rule webhook (its OWN opt-in): decrypt the rule's blob and post there, bypassing the
            // recipient's per-user SurfaceDiscord/webhook gate. Still Discord-allowlist-validated at send time.
            url = protector.Unprotect(item.WebhookOverrideEnc);
            if (string.IsNullOrEmpty(url) || !DiscordWebhookValidator.IsValid(url))
                return; // undecryptable / corrupt / no-longer-valid — drop quietly.
        }
        else
        {
            var pref = await db.NotificationPreferences.AsNoTracking()
                .FirstOrDefaultAsync(p => p.UserEmail == item.RecipientEmail, ct);
            if (pref is null || !pref.SurfaceDiscord || string.IsNullOrEmpty(pref.DiscordWebhookEnc))
                return; // toggled off or cleared since enqueue — nothing to do.

            // Decrypt ONLY in memory at send time; never logged, never stored back.
            url = protector.Unprotect(pref.DiscordWebhookEnc);
            if (string.IsNullOrEmpty(url) || !DiscordWebhookValidator.IsValid(url))
                return; // undecryptable / corrupt / no-longer-valid — drop quietly.
        }

        // Up to 2 attempts; on a 429 respect the retry-after (capped) once, then drop.
        for (var attempt = 0; attempt < 2; attempt++)
        {
            var result = await notifier.ForwardUserNotificationAsync(
                url!, item.Kind, item.ActorName, item.Text, item.Link, ct);

            if (result.Ok)
            {
                logger.LogInformation("Forwarded Discord notification to {Recipient} ({Kind}).",
                    item.RecipientEmail, item.Kind);
                return;
            }

            if (result.IsRateLimited && attempt == 0)
            {
                var wait = result.RetryAfter is { } ra && ra > TimeSpan.Zero
                    ? (ra > TimeSpan.FromSeconds(10) ? TimeSpan.FromSeconds(10) : ra)
                    : TimeSpan.FromSeconds(1);
                try { await Task.Delay(wait, ct); }
                catch (OperationCanceledException) when (ct.IsCancellationRequested) { return; }
                continue; // retry once
            }

            break; // non-success, non-retryable (or already retried) — drop.
        }

        logger.LogWarning("Discord forward to {Recipient} ({Kind}) did not succeed; dropped.",
            item.RecipientEmail, item.Kind);
    }

    /// <summary>A tiny lock-free-ish token bucket (per user). Not high-precision; just a spam cap.</summary>
    private sealed class TokenBucket(int capacity, double refillSeconds)
    {
        private double _tokens = capacity;
        private DateTime _last = DateTime.UtcNow;
        private readonly object _gate = new();

        public bool TryTake()
        {
            lock (_gate)
            {
                var now = DateTime.UtcNow;
                _tokens = Math.Min(capacity, _tokens + (now - _last).TotalSeconds / refillSeconds);
                _last = now;
                if (_tokens < 1) return false;
                _tokens -= 1;
                return true;
            }
        }
    }
}
