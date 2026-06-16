using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using Ccusage.Api.Data;
using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Ccusage.Api.Tests.Integration;

/// <summary>Exercises the remote-reporter ingest surface: key auth, write-through pricing/projects, dedup, revocation.</summary>
[Collection(IntegrationCollection.Name)]
public class IngestIntegrationTests(WebAppFactory factory)
{
    private HttpClient Admin()
    {
        var c = factory.CreateClient();
        c.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", TestJwt.For(WebAppFactory.AdminEmail));
        return c;
    }

    private HttpClient WithKey(string key)
    {
        var c = factory.CreateClient();
        c.DefaultRequestHeaders.Add("X-Ingest-Key", key);
        return c;
    }

    private async Task<(int id, string key)> CreateKeyAsync(string name = "test-reporter")
    {
        var resp = await Admin().PostAsJsonAsync("/api/ingest-keys", new { name });
        resp.StatusCode.Should().Be(HttpStatusCode.OK);
        var j = await resp.Content.ReadFromJsonAsync<JsonElement>();
        return (j.GetProperty("id").GetInt32(), j.GetProperty("key").GetString()!);
    }

    private static object Row(string dedupKey, string model = "claude-opus-4-8", string cwd = @"C:\work\ingest-repo") => new
    {
        dedupKey,
        timestampUtc = "2026-06-10T12:00:00Z",
        model,
        input = 1000L,
        output = 500L,
        cacheRead = 200L,
        cache5m = 0L,
        cache1h = 0L,
        sessionId = "sess-" + dedupKey,
        cwd,
        gitBranch = "main",
        isSidechain = false,
        agentId = (string?)null,
        version = "1.0.0",
    };

    [Fact]
    public async Task Ingest_without_a_key_is_unauthorized()
    {
        var resp = await factory.CreateClient().PostAsJsonAsync("/api/ingest",
            new { source = "claude", rows = new[] { Row(Guid.NewGuid().ToString("N")) } });
        resp.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task Ingest_with_a_bogus_key_is_unauthorized()
    {
        var resp = await WithKey("uiq_not-a-real-key").PostAsJsonAsync("/api/ingest",
            new { source = "claude", rows = new[] { Row(Guid.NewGuid().ToString("N")) } });
        resp.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task Key_management_requires_settings_manage()
    {
        var email = $"viewer-{Guid.NewGuid():N}@test.local";
        await Admin().PostAsJsonAsync("/api/users",
            new { email, isEnabled = true, permissions = new[] { "dashboard.view" } });

        var viewer = factory.CreateClient();
        viewer.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", TestJwt.For(email));
        (await viewer.GetAsync("/api/ingest-keys")).StatusCode.Should().Be(HttpStatusCode.Forbidden);
        (await Admin().GetAsync("/api/ingest-keys")).StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Fact]
    public async Task Generated_key_ingests_prices_resolves_project_and_dedupes()
    {
        var (_, key) = await CreateKeyAsync();
        var k1 = Guid.NewGuid().ToString("N");
        var k2 = Guid.NewGuid().ToString("N");
        var batch = new { source = "claude", machine = "test-machine", rows = new[] { Row(k1), Row(k2) } };

        var first = await WithKey(key).PostAsJsonAsync("/api/ingest", batch);
        first.StatusCode.Should().Be(HttpStatusCode.OK);
        var r1 = await first.Content.ReadFromJsonAsync<JsonElement>();
        r1.GetProperty("received").GetInt32().Should().Be(2);
        r1.GetProperty("inserted").GetInt32().Should().Be(2);
        r1.GetProperty("insertedTokens").GetInt64().Should().Be(3400); // 2 rows × (1000+500+200) combined tokens

        using (var scope = factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<UsageDbContext>();
            var rows = await db.UsageRecords.Where(r => r.DedupKey == k1 || r.DedupKey == k2).ToListAsync();
            rows.Should().HaveCount(2);
            rows.Should().OnlyContain(r => r.Source == "claude-code");      // kind → canonical source label
            rows.Should().OnlyContain(r => r.CostUsd > 0);                  // opus-4-8 is priced server-side
            (await db.Projects.AnyAsync(p => p.RepoRoot == @"C:\work\ingest-repo")).Should().BeTrue();
            (await db.IngestedFiles.AnyAsync(f => f.Path == "remote://test-machine/claude-code")).Should().BeTrue();
        }

        // Re-pushing the exact same batch must insert nothing (idempotent on the unique key).
        var second = await WithKey(key).PostAsJsonAsync("/api/ingest", batch);
        var r2 = await second.Content.ReadFromJsonAsync<JsonElement>();
        r2.GetProperty("inserted").GetInt32().Should().Be(0);
        r2.GetProperty("duplicates").GetInt32().Should().Be(2);
    }

    [Fact]
    public async Task Revoked_key_is_rejected_on_the_next_request()
    {
        var (id, key) = await CreateKeyAsync("to-revoke");

        var ok = await WithKey(key).PostAsJsonAsync("/api/ingest",
            new { source = "claude", rows = new[] { Row(Guid.NewGuid().ToString("N")) } });
        ok.StatusCode.Should().Be(HttpStatusCode.OK);

        (await Admin().DeleteAsync($"/api/ingest-keys/{id}")).StatusCode.Should().Be(HttpStatusCode.NoContent);

        var after = await WithKey(key).PostAsJsonAsync("/api/ingest",
            new { source = "claude", rows = new[] { Row(Guid.NewGuid().ToString("N")) } });
        after.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task Unknown_source_is_rejected()
    {
        var (_, key) = await CreateKeyAsync("bad-source");
        var resp = await WithKey(key).PostAsJsonAsync("/api/ingest",
            new { source = "bogus", rows = new[] { Row(Guid.NewGuid().ToString("N")) } });
        resp.StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task Oversized_token_count_is_clamped_not_a_poison_pill()
    {
        var (_, key) = await CreateKeyAsync("overflow");
        var huge = Guid.NewGuid().ToString("N");
        var normal = Guid.NewGuid().ToString("N");

        // 2e14 output tokens for a priced model would price to ~1.5e10 USD and overflow numeric(18,8)
        // on save. The server must clamp it and still land the whole batch — never a 500, never a
        // poisoned batch that blocks the normal row.
        var hugeRow = new
        {
            dedupKey = huge, timestampUtc = "2026-06-10T12:00:00Z", model = "claude-opus-4-8",
            input = 1000L, output = 200_000_000_000_000L, cacheRead = 0L, cache5m = 0L, cache1h = 0L,
            sessionId = "s", cwd = @"C:\work\ingest-repo", gitBranch = "main", isSidechain = false,
            agentId = (string?)null, version = "1.0",
        };

        var resp = await WithKey(key).PostAsJsonAsync("/api/ingest",
            new { source = "claude", rows = new object[] { hugeRow, Row(normal) } });
        resp.StatusCode.Should().Be(HttpStatusCode.OK);
        var r = await resp.Content.ReadFromJsonAsync<JsonElement>();
        r.GetProperty("inserted").GetInt32().Should().Be(2);

        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<UsageDbContext>();
        var row = await db.UsageRecords.AsNoTracking().FirstAsync(x => x.DedupKey == huge);
        row.CostUsd.Should().BeGreaterThan(0m).And.BeLessThan(9_999_999_999m); // finite, fits the column
    }

    [Fact]
    public async Task Malformed_rows_are_dropped_not_fatal()
    {
        var (_, key) = await CreateKeyAsync("malformed");
        var good = Guid.NewGuid().ToString("N");
        // One valid row, one with a blank dedup key, one with a blank model — only the valid one lands.
        var batch = new
        {
            source = "claude",
            rows = new object[]
            {
                Row(good),
                Row("", "claude-opus-4-8"),
                Row(Guid.NewGuid().ToString("N"), ""),
            },
        };
        var resp = await WithKey(key).PostAsJsonAsync("/api/ingest", batch);
        resp.StatusCode.Should().Be(HttpStatusCode.OK);
        var r = await resp.Content.ReadFromJsonAsync<JsonElement>();
        r.GetProperty("inserted").GetInt32().Should().Be(1);
    }

    [Fact]
    public async Task Ingest_bumps_the_dashboard_sync_status()
    {
        var (_, key) = await CreateKeyAsync("syncstatus");
        var before = DateTime.UtcNow.AddSeconds(-5);
        await WithKey(key).PostAsJsonAsync("/api/ingest",
            new { source = "claude", rows = new[] { Row(Guid.NewGuid().ToString("N")) } });

        // The dashboard's "Synced X ago" chip reads /api/sync/status — ingest must move it.
        var status = await (await Admin().GetAsync("/api/sync/status")).Content.ReadFromJsonAsync<JsonElement>();
        status.GetProperty("lastSyncUtc").GetDateTime().Should().BeAfter(before);
    }
}
