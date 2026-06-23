using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using Ccusage.Api.Data;
using Ccusage.Api.Data.Entities;
using Ccusage.Api.Services;
using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Ccusage.Api.Tests.Integration;

/// <summary>
/// The automations engine end-to-end (<see cref="AutomationRule"/> + <see cref="RuleEvaluator"/> hooked into
/// <see cref="ActivityEmitter"/> + <c>/api/automations</c> CRUD):
/// <list type="bullet">
///   <item>A rule fires on the OWNER'S own matching event (condition true) — writing a self-notification.</item>
///   <item>It does NOT fire when the condition is false, the rule is disabled, or it's a different kind.</item>
///   <item>It NEVER fires on ANOTHER user's event (a rule is triggered only by its owner's actions).</item>
///   <item>The DiscordDm action sends ONLY to the owner's own webhook (no cross-user; no email/secret leak).</item>
///   <item>A throwing action never breaks the emit caller (fire-and-forget / never-throw is preserved).</item>
///   <item>CRUD is strictly owner-scoped: a caller cannot read or edit another user's rule (404).</item>
/// </list>
/// </summary>
[Collection(IntegrationCollection.Name)]
public class AutomationsTests(WebAppFactory factory)
{
    private HttpClient Admin()
    {
        var c = factory.CreateClient();
        c.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", TestJwt.For(WebAppFactory.AdminEmail));
        return c;
    }

    private HttpClient Client(string email)
    {
        var c = factory.CreateClient();
        c.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", TestJwt.For(email));
        return c;
    }

    private async Task<(string email, HttpClient client)> ProvisionUser(params string[] permissions)
    {
        var email = $"auto-{Guid.NewGuid():N}@test.local";
        var res = await Admin().PostAsJsonAsync("/api/users", new { email, isEnabled = true, permissions });
        res.StatusCode.Should().Be(HttpStatusCode.Created);
        return (email.ToLowerInvariant(), Client(email));
    }

    /// <summary>Opt the user into sharing so the emitter actually persists events (the rule hook runs after).</summary>
    private async Task SetSharing(string email, bool share)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<UsageDbContext>();
        var u = await db.Users.FirstAsync(x => x.Email == email);
        u.ShareActivity = share;
        await db.SaveChangesAsync();
    }

    /// <summary>Store an encrypted, valid (SSRF-allowlisted) Discord webhook for the user + flip SurfaceDiscord.</summary>
    private async Task SetOwnWebhook(string email, string token)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<UsageDbContext>();
        var protector = scope.ServiceProvider.GetRequiredService<TokenProtector>();
        var pref = await db.NotificationPreferences.FirstOrDefaultAsync(p => p.UserEmail == email);
        if (pref is null)
        {
            pref = new NotificationPreference { UserEmail = email };
            db.NotificationPreferences.Add(pref);
        }
        pref.DiscordWebhookEnc = protector.Protect($"https://discord.com/api/webhooks/123456789/{token}");
        pref.DiscordWebhookHint = "...hint";
        pref.SurfaceDiscord = true;
        pref.NotifySystemEvents = true;
        pref.UpdatedUtc = DateTime.UtcNow;
        await db.SaveChangesAsync();
    }

    private async Task EmitAsync(string actorEmail, string kind, int? intValue = null, string? label = null)
    {
        using var scope = factory.Services.CreateScope();
        var emitter = scope.ServiceProvider.GetRequiredService<ActivityEmitter>();
        await emitter.EmitAsync(actorEmail, kind, intValue, label);
    }

    private async Task<int> CountSelfNotifications(string email, NotificationType type = NotificationType.SystemAutomation)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<UsageDbContext>();
        return await db.Notifications.AsNoTracking()
            .CountAsync(n => n.RecipientEmail == email && n.Type == type);
    }

    /// <summary>Insert a rule directly (bypassing CRUD) for evaluator-focused tests.</summary>
    private async Task<int> SeedRule(
        string ownerEmail, string kind, RuleAction action, RuleConditionOp op = RuleConditionOp.None,
        int? value = null, bool enabled = true, string? template = null)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<UsageDbContext>();
        var rule = new AutomationRule
        {
            OwnerEmail = ownerEmail, Name = "test rule", TriggerKind = kind,
            ConditionOp = op, ConditionValue = value, Action = action, MessageTemplate = template,
            Enabled = enabled, CreatedUtc = DateTime.UtcNow, UpdatedUtc = DateTime.UtcNow,
        };
        db.AutomationRules.Add(rule);
        await db.SaveChangesAsync();
        return rule.Id;
    }

    private static async Task<JsonElement> Json(HttpResponseMessage resp) =>
        await resp.Content.ReadFromJsonAsync<JsonElement>();

    private static readonly string Today = DateTime.UtcNow.ToString("yyyy-MM-dd");

    /// <summary>Poll the Discord capture until at least <paramref name="atLeast"/> sends land, or time out.</summary>
    private async Task<bool> WaitForDiscord(int before, int atLeast = 1, int timeoutMs = 3000)
    {
        var deadline = DateTime.UtcNow.AddMilliseconds(timeoutMs);
        while (DateTime.UtcNow < deadline)
        {
            if (factory.Discord.Count - before >= atLeast) return true;
            await Task.Delay(50);
        }
        return factory.Discord.Count - before >= atLeast;
    }

    // ---- CRUD gating + owner-scoping ----

    [Fact]
    public async Task Automations_requires_authentication_and_tracker_self()
    {
        var anon = factory.CreateClient();
        (await anon.GetAsync("/api/automations")).StatusCode.Should().Be(HttpStatusCode.Unauthorized);

        var (_, noTracker) = await ProvisionUser("dashboard.view");
        (await noTracker.GetAsync("/api/automations")).StatusCode.Should().Be(HttpStatusCode.Forbidden);
    }

    [Fact]
    public async Task Create_then_list_returns_only_the_callers_own_rules()
    {
        var (_, alice) = await ProvisionUser("tracker.self");
        var (_, bob) = await ProvisionUser("tracker.self");

        var created = await alice.PostAsJsonAsync("/api/automations", new
        {
            name = "Long run alert", triggerKind = ActivityEmitter.Kinds.WorkoutLogged,
            conditionOp = (int)RuleConditionOp.Gte, conditionValue = 30,
            action = (int)RuleAction.InAppNotify, messageTemplate = "Nice {value}-min run!", enabled = true,
        });
        created.StatusCode.Should().Be(HttpStatusCode.OK);

        var aliceList = (await Json(await alice.GetAsync("/api/automations"))).EnumerateArray().ToList();
        aliceList.Should().ContainSingle();
        aliceList[0].GetProperty("name").GetString().Should().Be("Long run alert");
        // DTO carries NO owner email / webhook / secret.
        aliceList[0].TryGetProperty("ownerEmail", out _).Should().BeFalse();

        // Bob sees none of Alice's rules.
        (await Json(await bob.GetAsync("/api/automations"))).EnumerateArray().Should().BeEmpty();
    }

    [Fact]
    public async Task Create_rejects_an_unknown_trigger_kind()
    {
        var (_, alice) = await ProvisionUser("tracker.self");
        var res = await alice.PostAsJsonAsync("/api/automations", new
        {
            triggerKind = "not.a.kind", conditionOp = 0, action = 0, enabled = true,
        });
        res.StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task Caller_cannot_update_or_delete_another_users_rule()
    {
        var (aliceEmail, alice) = await ProvisionUser("tracker.self");
        var (_, bob) = await ProvisionUser("tracker.self");
        var ruleId = await SeedRule(aliceEmail, ActivityEmitter.Kinds.WorkoutLogged, RuleAction.InAppNotify);

        // Bob tries to read-by-edit and delete Alice's rule — both 404 (no existence leak).
        var put = await bob.PutAsJsonAsync($"/api/automations/{ruleId}", new
        {
            triggerKind = ActivityEmitter.Kinds.WorkoutLogged, conditionOp = 0, action = 0, enabled = false,
        });
        put.StatusCode.Should().Be(HttpStatusCode.NotFound);
        (await bob.DeleteAsync($"/api/automations/{ruleId}")).StatusCode.Should().Be(HttpStatusCode.NotFound);

        // The rule is untouched and still owned by Alice.
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<UsageDbContext>();
        var rule = await db.AutomationRules.AsNoTracking().FirstAsync(r => r.Id == ruleId);
        rule.OwnerEmail.Should().Be(aliceEmail);
        rule.Enabled.Should().BeTrue();
    }

    [Fact]
    public async Task Create_forces_owner_to_the_caller_even_if_a_body_tries_to_set_it()
    {
        var (aliceEmail, alice) = await ProvisionUser("tracker.self");
        // The DTO has no ownerEmail field, but send one anyway — it must be ignored; owner = caller.
        var created = await alice.PostAsJsonAsync("/api/automations", new
        {
            ownerEmail = "victim@test.local",
            triggerKind = ActivityEmitter.Kinds.HydrationGoalHit, conditionOp = 0, action = 0, enabled = true,
        });
        created.StatusCode.Should().Be(HttpStatusCode.OK);
        var newId = (await Json(created)).GetProperty("id").GetInt32();

        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<UsageDbContext>();
        var rule = await db.AutomationRules.AsNoTracking().FirstAsync(r => r.Id == newId);
        rule.OwnerEmail.Should().Be(aliceEmail, "owner is always the caller, never the body");
        rule.OwnerEmail.Should().NotBe("victim@test.local");
        // And no rule was ever created under the spoofed owner.
        (await db.AutomationRules.AsNoTracking().AnyAsync(r => r.OwnerEmail == "victim@test.local"))
            .Should().BeFalse();
    }

    // ---- Evaluator: fires / does not fire ----

    [Fact]
    public async Task Rule_fires_on_owners_matching_event_when_condition_true()
    {
        var (email, _) = await ProvisionUser("tracker.self");
        await SetSharing(email, true);
        await SeedRule(email, ActivityEmitter.Kinds.WorkoutLogged, RuleAction.InAppNotify, RuleConditionOp.Gte, 30);

        await EmitAsync(email, ActivityEmitter.Kinds.WorkoutLogged, 45, "Run"); // 45 >= 30 -> fires

        (await CountSelfNotifications(email)).Should().Be(1);
    }

    [Fact]
    public async Task Rule_does_not_fire_when_condition_false()
    {
        var (email, _) = await ProvisionUser("tracker.self");
        await SetSharing(email, true);
        await SeedRule(email, ActivityEmitter.Kinds.WorkoutLogged, RuleAction.InAppNotify, RuleConditionOp.Gte, 30);

        await EmitAsync(email, ActivityEmitter.Kinds.WorkoutLogged, 20, "Walk"); // 20 < 30 -> no fire

        (await CountSelfNotifications(email)).Should().Be(0);
    }

    [Fact]
    public async Task Disabled_rule_does_not_fire()
    {
        var (email, _) = await ProvisionUser("tracker.self");
        await SetSharing(email, true);
        await SeedRule(email, ActivityEmitter.Kinds.HydrationGoalHit, RuleAction.InAppNotify, enabled: false);

        await EmitAsync(email, ActivityEmitter.Kinds.HydrationGoalHit);

        (await CountSelfNotifications(email)).Should().Be(0);
    }

    [Fact]
    public async Task Rule_does_not_fire_on_a_different_kind()
    {
        var (email, _) = await ProvisionUser("tracker.self");
        await SetSharing(email, true);
        await SeedRule(email, ActivityEmitter.Kinds.WorkoutLogged, RuleAction.InAppNotify);

        await EmitAsync(email, ActivityEmitter.Kinds.HydrationGoalHit); // different kind -> no fire

        (await CountSelfNotifications(email)).Should().Be(0);
    }

    [Fact]
    public async Task Rule_never_fires_on_another_users_event()
    {
        var (ownerEmail, _) = await ProvisionUser("tracker.self");
        var (strangerEmail, _) = await ProvisionUser("tracker.self");
        await SetSharing(ownerEmail, true);
        await SetSharing(strangerEmail, true);
        // The rule belongs to the owner; the STRANGER performs the action.
        await SeedRule(ownerEmail, ActivityEmitter.Kinds.WorkoutLogged, RuleAction.InAppNotify);

        await EmitAsync(strangerEmail, ActivityEmitter.Kinds.WorkoutLogged, 60, "Run");

        // Neither user gets the owner's rule's notification — the rule triggers only on the owner's own events.
        (await CountSelfNotifications(ownerEmail)).Should().Be(0, "a rule never fires on someone else's event");
        (await CountSelfNotifications(strangerEmail)).Should().Be(0, "the stranger owns no such rule");
    }

    // ---- DiscordDm action: own webhook only, no leak ----

    [Fact]
    public async Task DiscordDm_action_sends_only_to_the_owners_own_webhook_with_no_email_or_secret_leak()
    {
        var (email, _) = await ProvisionUser("tracker.self");
        await SetSharing(email, true);
        var token = $"SECRET-{Guid.NewGuid():N}";
        await SetOwnWebhook(email, token);
        await SeedRule(email, ActivityEmitter.Kinds.ChallengeStarted, RuleAction.DiscordDm,
            template: "I just started 75 Hard!");

        var before = factory.Discord.Count;
        await EmitAsync(email, ActivityEmitter.Kinds.ChallengeStarted);

        (await WaitForDiscord(before)).Should().BeTrue("the DiscordDm action enqueues a forward to the own webhook");

        var payload = factory.Discord.Payloads.Last();
        payload.Should().Contain("I just started 75 Hard!");
        // Privacy: the embed body never carries the owner's email or the raw webhook token.
        payload.Should().NotContain(email);
        payload.Should().NotContain(token);
    }

    // ---- Never-throws: a failing action never breaks the emit caller ----

    [Fact]
    public async Task A_throwing_action_never_breaks_the_emit_caller_and_the_event_still_persists()
    {
        var (email, _) = await ProvisionUser("tracker.self");
        await SetSharing(email, true);
        // DiscordDm with SurfaceDiscord OFF / no webhook: the forwarder no-ops; even an internal failure is
        // swallowed by the evaluator. The emit itself must still succeed and persist the activity event.
        await SeedRule(email, ActivityEmitter.Kinds.WorkoutLogged, RuleAction.DiscordDm);

        var act = async () => await EmitAsync(email, ActivityEmitter.Kinds.WorkoutLogged, 30, "Run");
        await act.Should().NotThrowAsync();

        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<UsageDbContext>();
        (await db.ActivityEvents.AsNoTracking()
            .AnyAsync(e => e.ActorEmail == email && e.Kind == "workout.logged"))
            .Should().BeTrue("the activity emit must persist even if a rule action can't deliver");
    }
}
