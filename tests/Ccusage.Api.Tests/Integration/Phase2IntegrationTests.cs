using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using FluentAssertions;

namespace Ccusage.Api.Tests.Integration;

/// <summary>
/// Phase 2: cache-efficiency rollup, per-user saved views (CRUD + isolation + upsert), and the
/// fable-5 pricing fix (no longer flagged as placeholder while genuinely-unpriced models still are).
/// </summary>
[Collection(IntegrationCollection.Name)]
public class Phase2IntegrationTests(WebAppFactory factory)
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

    private HttpClient WithKey(string key)
    {
        var c = factory.CreateClient();
        c.DefaultRequestHeaders.Add("X-Ingest-Key", key);
        return c;
    }

    private async Task<(string email, HttpClient client)> ProvisionUser(params string[] permissions)
    {
        var email = $"sv-{Guid.NewGuid():N}@test.local";
        var res = await Admin().PostAsJsonAsync("/api/users", new { email, isEnabled = true, permissions });
        res.StatusCode.Should().Be(HttpStatusCode.Created);
        return (email, Client(email));
    }

    private async Task<string> CreateIngestKeyAsync()
    {
        var resp = await Admin().PostAsJsonAsync("/api/ingest-keys", new { name = "phase2-" + Guid.NewGuid().ToString("N")[..6] });
        resp.StatusCode.Should().Be(HttpStatusCode.OK);
        var j = await resp.Content.ReadFromJsonAsync<JsonElement>();
        return j.GetProperty("key").GetString()!;
    }

    private static object CacheRow(string dedupKey, string model) => new
    {
        dedupKey,
        timestampUtc = "2026-06-11T12:00:00Z",
        model,
        input = 1_000_000L,     // 1M input
        output = 200_000L,
        cacheRead = 4_000_000L, // 4M served from cache
        cache5m = 500_000L,     // cache-creation tiers
        cache1h = 100_000L,
        sessionId = "sess-" + dedupKey,
        cwd = @"C:\work\phase2-repo",
        gitBranch = "main",
        isSidechain = false,
        agentId = (string?)null,
        version = "1.0.0",
    };

    // ---- Cache efficiency ----

    [Fact]
    public async Task Cache_efficiency_requires_authentication()
        => (await factory.CreateClient().GetAsync("/api/usage/cache-efficiency"))
            .StatusCode.Should().Be(HttpStatusCode.Unauthorized);

    [Fact]
    public async Task Cache_efficiency_is_gated_by_dashboard_or_calendar_view()
    {
        var (_, dash) = await ProvisionUser("dashboard.view");
        (await dash.GetAsync("/api/usage/cache-efficiency")).StatusCode.Should().Be(HttpStatusCode.OK);

        var (_, cal) = await ProvisionUser("calendar.view");
        (await cal.GetAsync("/api/usage/cache-efficiency")).StatusCode.Should().Be(HttpStatusCode.OK);

        var (_, neither) = await ProvisionUser("sync.run");
        (await neither.GetAsync("/api/usage/cache-efficiency")).StatusCode.Should().Be(HttpStatusCode.Forbidden);
    }

    [Fact]
    public async Task Cache_efficiency_returns_sane_non_negative_numbers_and_a_0_to_1_ratio()
    {
        // Seed priced (opus) rows with cache tokens so savings/cost are positive.
        var key = await CreateIngestKeyAsync();
        var k1 = Guid.NewGuid().ToString("N");
        var k2 = Guid.NewGuid().ToString("N");
        await WithKey(key).PostAsJsonAsync("/api/ingest", new
        {
            source = "claude",
            machine = "cache-box",
            rows = new[] { CacheRow(k1, "claude-opus-4-8"), CacheRow(k2, "claude-opus-4-8") },
        });

        var eff = await (await Admin().GetAsync("/api/usage/cache-efficiency")).Content.ReadFromJsonAsync<JsonElement>();

        eff.GetProperty("cacheReadTokens").GetInt64().Should().BeGreaterThanOrEqualTo(8_000_000);
        eff.GetProperty("inputTokens").GetInt64().Should().BeGreaterThanOrEqualTo(2_000_000);
        eff.GetProperty("cacheWriteTokens").GetInt64().Should()
            .Be(eff.GetProperty("cacheWrite5mTokens").GetInt64() + eff.GetProperty("cacheWrite1hTokens").GetInt64());
        eff.GetProperty("recordCount").GetInt32().Should().BeGreaterThanOrEqualTo(2);

        var ratio = eff.GetProperty("cacheReadRatio").GetDouble();
        ratio.Should().BeInRange(0d, 1d);
        // 8M read / (8M read + 2M input) = 0.8 (plus any other seeded rows nudges it, still <1).
        ratio.Should().BeGreaterThan(0d);

        // opus: input 15/Mtok, cache-read 1.5/Mtok → savings = 8M × (15-1.5)/1M = $108 (≥, with other rows).
        eff.GetProperty("savingsUsd").GetDecimal().Should().BeGreaterThanOrEqualTo(0m);
        eff.GetProperty("savingsUsd").GetDecimal().Should().BeGreaterThan(0m);
        eff.GetProperty("cacheWriteCostUsd").GetDecimal().Should().BeGreaterThanOrEqualTo(0m);
    }

    [Fact]
    public async Task Cache_efficiency_with_no_matching_rows_is_zeroed_not_an_error()
    {
        // A far-future window matches nothing → all zero, ratio 0, no division-by-zero.
        var eff = await (await Admin().GetAsync("/api/usage/cache-efficiency?from=2099-01-01&to=2099-01-02"))
            .Content.ReadFromJsonAsync<JsonElement>();

        eff.GetProperty("recordCount").GetInt32().Should().Be(0);
        eff.GetProperty("cacheReadRatio").GetDouble().Should().Be(0d);
        eff.GetProperty("savingsUsd").GetDecimal().Should().Be(0m);
        eff.GetProperty("cacheWriteCostUsd").GetDecimal().Should().Be(0m);
    }

    // ---- Saved views: CRUD, per-user isolation, upsert-by-name ----

    private static object ViewBody(string name, string groupBy = "day", string[]? source = null) => new
    {
        name,
        from = (string?)null,
        to = (string?)null,
        projectId = Array.Empty<int>(),
        model = Array.Empty<string>(),
        source = source ?? Array.Empty<string>(),
        includeSidechain = true,
        groupBy,
    };

    [Fact]
    public async Task Saved_views_require_authentication()
        => (await factory.CreateClient().GetAsync("/api/saved-views")).StatusCode.Should().Be(HttpStatusCode.Unauthorized);

    [Fact]
    public async Task Saved_views_are_gated_by_dashboard_or_calendar_view()
    {
        var (_, ok) = await ProvisionUser("calendar.view");
        (await ok.GetAsync("/api/saved-views")).StatusCode.Should().Be(HttpStatusCode.OK);

        var (_, denied) = await ProvisionUser("sync.run");
        (await denied.GetAsync("/api/saved-views")).StatusCode.Should().Be(HttpStatusCode.Forbidden);
    }

    [Fact]
    public async Task Saved_view_create_list_update_delete_round_trips()
    {
        var (_, c) = await ProvisionUser("dashboard.view");

        var created = await (await c.PostAsJsonAsync("/api/saved-views", ViewBody("My View", "model", new[] { "codex" })))
            .Content.ReadFromJsonAsync<JsonElement>();
        var id = created.GetProperty("id").GetInt32();
        created.GetProperty("name").GetString().Should().Be("My View");
        created.GetProperty("groupBy").GetString().Should().Be("model");
        created.GetProperty("source").EnumerateArray().Select(e => e.GetString()).Should().Contain("codex");

        // Appears in the caller's list.
        var list = await (await c.GetAsync("/api/saved-views")).Content.ReadFromJsonAsync<JsonElement>();
        list.EnumerateArray().Select(e => e.GetProperty("id").GetInt32()).Should().Contain(id);

        // Update name + filter.
        var put = await c.PutAsJsonAsync($"/api/saved-views/{id}", ViewBody("Renamed", "project"));
        put.StatusCode.Should().Be(HttpStatusCode.OK);
        (await put.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("name").GetString().Should().Be("Renamed");

        // Delete.
        (await c.DeleteAsync($"/api/saved-views/{id}")).StatusCode.Should().Be(HttpStatusCode.NoContent);
        var after = await (await c.GetAsync("/api/saved-views")).Content.ReadFromJsonAsync<JsonElement>();
        after.EnumerateArray().Select(e => e.GetProperty("id").GetInt32()).Should().NotContain(id);
    }

    [Fact]
    public async Task Saved_view_requires_a_non_empty_name()
    {
        var (_, c) = await ProvisionUser("dashboard.view");
        (await c.PostAsJsonAsync("/api/saved-views", ViewBody("   ")))
            .StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task Saved_view_post_upserts_by_name_rather_than_duplicating()
    {
        var (_, c) = await ProvisionUser("dashboard.view");

        var first = await (await c.PostAsJsonAsync("/api/saved-views", ViewBody("Dupe", "day")))
            .Content.ReadFromJsonAsync<JsonElement>();
        var firstId = first.GetProperty("id").GetInt32();

        // Same name → updates the existing row (same id), changes the filter.
        var second = await (await c.PostAsJsonAsync("/api/saved-views", ViewBody("Dupe", "model")))
            .Content.ReadFromJsonAsync<JsonElement>();
        second.GetProperty("id").GetInt32().Should().Be(firstId);
        second.GetProperty("groupBy").GetString().Should().Be("model");

        // Only one "Dupe" view exists for this user.
        var list = await (await c.GetAsync("/api/saved-views")).Content.ReadFromJsonAsync<JsonElement>();
        list.EnumerateArray().Count(e => e.GetProperty("name").GetString() == "Dupe").Should().Be(1);
    }

    [Fact]
    public async Task Saved_views_are_isolated_per_user_for_list_read_update_and_delete()
    {
        var (_, a) = await ProvisionUser("dashboard.view");
        var (_, b) = await ProvisionUser("dashboard.view");

        // A creates a view.
        var aView = await (await a.PostAsJsonAsync("/api/saved-views", ViewBody("A-only")))
            .Content.ReadFromJsonAsync<JsonElement>();
        var aId = aView.GetProperty("id").GetInt32();

        // B never sees A's view in their list.
        var bList = await (await b.GetAsync("/api/saved-views")).Content.ReadFromJsonAsync<JsonElement>();
        bList.EnumerateArray().Select(e => e.GetProperty("id").GetInt32()).Should().NotContain(aId);
        bList.EnumerateArray().Select(e => e.GetProperty("name").GetString()).Should().NotContain("A-only");

        // B cannot update A's view — 404 (existence not leaked), and A's data is untouched.
        var bUpdate = await b.PutAsJsonAsync($"/api/saved-views/{aId}", ViewBody("Hijacked"));
        bUpdate.StatusCode.Should().Be(HttpStatusCode.NotFound);

        // B cannot delete A's view either.
        (await b.DeleteAsync($"/api/saved-views/{aId}")).StatusCode.Should().Be(HttpStatusCode.NotFound);

        // A's view still exists, unchanged.
        var aList = await (await a.GetAsync("/api/saved-views")).Content.ReadFromJsonAsync<JsonElement>();
        var stillThere = aList.EnumerateArray().First(e => e.GetProperty("id").GetInt32() == aId);
        stillThere.GetProperty("name").GetString().Should().Be("A-only");
    }

    [Fact]
    public async Task Two_users_can_hold_views_with_the_same_name_independently()
    {
        var (_, a) = await ProvisionUser("dashboard.view");
        var (_, b) = await ProvisionUser("dashboard.view");

        var aId = (await (await a.PostAsJsonAsync("/api/saved-views", ViewBody("Shared Name", "day")))
            .Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetInt32();
        var bId = (await (await b.PostAsJsonAsync("/api/saved-views", ViewBody("Shared Name", "model")))
            .Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetInt32();

        // Same name, distinct rows owned by distinct users (no cross-user upsert collision).
        aId.Should().NotBe(bId);

        var aList = await (await a.GetAsync("/api/saved-views")).Content.ReadFromJsonAsync<JsonElement>();
        aList.EnumerateArray().First(e => e.GetProperty("name").GetString() == "Shared Name")
            .GetProperty("groupBy").GetString().Should().Be("day");
    }

    // ---- Fable-5 pricing fix ----

    [Fact]
    public async Task Placeholder_warning_no_longer_flags_fable5_but_still_flags_genuinely_unpriced()
    {
        var key = await CreateIngestKeyAsync();
        var fable = Guid.NewGuid().ToString("N");
        var unknown = Guid.NewGuid().ToString("N");

        await WithKey(key).PostAsJsonAsync("/api/ingest", new
        {
            source = "claude",
            machine = "pricing-box",
            rows = new[]
            {
                CacheRow(fable, "claude-fable-5"),
                CacheRow(unknown, "totally-unknown-model-zzz"),
            },
        });

        var models = await (await Admin().GetAsync("/api/models")).Content.ReadFromJsonAsync<JsonElement>();
        var list = models.EnumerateArray().ToList();

        var fableStat = list.First(m => m.GetProperty("model").GetString() == "claude-fable-5");
        fableStat.GetProperty("isPlaceholderPricing").GetBoolean().Should().BeFalse();
        // The seeded estimate is non-zero, so fable-5 now produces real cost.
        fableStat.GetProperty("costUsd").GetDecimal().Should().BeGreaterThan(0m);

        // A model resolved only via the '*' fallback is still flagged.
        var unknownStat = list.First(m => m.GetProperty("model").GetString() == "totally-unknown-model-zzz");
        unknownStat.GetProperty("isPlaceholderPricing").GetBoolean().Should().BeTrue();
    }
}
