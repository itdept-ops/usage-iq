using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using Ccusage.Api.Data;
using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Ccusage.Api.Tests.Integration;

/// <summary>
/// Family Hub F6b — DOODLE-STYLE PLAN POLLS (/api/family/polls). Covers: family.use gating (403) +
/// unauthenticated (401); creating TIME and TEXT polls with options; Doodle voting (mark every option that
/// works) and REPLACE semantics (re-voting wipes prior votes for that poll); per-option vote counts + voter
/// NAMES with NO email anywhere; closing picks the most-voted winner by default (and honors an explicit
/// winner); booking a TEXT option is a 400 (only time options book), and booking when not connected is a
/// graceful 400; cross-household isolation (a caller can't see or touch another household's poll). Each test
/// provisions fresh users so they're order-independent.
/// </summary>
[Collection(IntegrationCollection.Name)]
public class FamilyPollsTests(WebAppFactory factory)
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

    private async Task<(string email, HttpClient client, int id)> ProvisionUser(params string[] permissions)
    {
        var email = $"fampoll-{Guid.NewGuid():N}@test.local";
        var res = await Admin().PostAsJsonAsync("/api/users", new { email, isEnabled = true, permissions });
        res.StatusCode.Should().Be(HttpStatusCode.Created);
        var id = (await Json(res)).GetProperty("id").GetInt32();
        return (email, Client(email), id);
    }

    private static async Task<JsonElement> Json(HttpResponseMessage resp) =>
        await resp.Content.ReadFromJsonAsync<JsonElement>();

    private static bool HasProperty(JsonElement el, string name) =>
        el.ValueKind == JsonValueKind.Object && el.TryGetProperty(name, out _);

    /// <summary>Create a 3-option TIME poll owned by the caller; returns the poll DTO.</summary>
    private static async Task<JsonElement> CreateTimePoll(HttpClient owner)
    {
        var d1s = new DateTime(2026, 7, 1, 18, 0, 0, DateTimeKind.Utc);
        var d2s = new DateTime(2026, 7, 2, 18, 0, 0, DateTimeKind.Utc);
        var res = await owner.PostAsJsonAsync("/api/family/polls", new
        {
            title = "Movie night",
            kind = "time",
            options = new[]
            {
                new { startUtc = d1s, endUtc = d1s.AddHours(2) },
                new { startUtc = d2s, endUtc = d2s.AddHours(2) },
            },
        });
        res.StatusCode.Should().Be(HttpStatusCode.OK);
        return await Json(res);
    }

    // =====================================================================================
    // GATING
    // =====================================================================================

    [Fact]
    public async Task Polls_require_family_use()
    {
        var (_, plain, _) = await ProvisionUser("dashboard.view");

        (await plain.GetAsync("/api/family/polls")).StatusCode.Should().Be(HttpStatusCode.Forbidden);
        (await plain.PostAsJsonAsync("/api/family/polls", new { title = "X", kind = "text", options = new[] { new { label = "a" }, new { label = "b" } } }))
            .StatusCode.Should().Be(HttpStatusCode.Forbidden);
    }

    [Fact]
    public async Task Polls_require_authentication()
    {
        var anon = factory.CreateClient();
        (await anon.GetAsync("/api/family/polls")).StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    // =====================================================================================
    // CREATE — time + text
    // =====================================================================================

    [Fact]
    public async Task Create_a_time_poll_returns_options_with_slots_and_no_email()
    {
        var (_, owner, ownerId) = await ProvisionUser("family.use");
        await owner.GetAsync("/api/family/household");

        var poll = await CreateTimePoll(owner);
        poll.GetProperty("title").GetString().Should().Be("Movie night");
        poll.GetProperty("kind").GetString().Should().Be("time");
        poll.GetProperty("closed").GetBoolean().Should().BeFalse();
        poll.GetProperty("createdByUserId").GetInt32().Should().Be(ownerId);
        poll.GetProperty("createdByName").GetString().Should().NotBeNullOrWhiteSpace();

        var options = poll.GetProperty("options");
        options.GetArrayLength().Should().Be(2);
        options[0].GetProperty("startUtc").ValueKind.Should().Be(JsonValueKind.String);
        options[0].GetProperty("voteCount").GetInt32().Should().Be(0);
        poll.GetRawText().Should().NotContain("@");
    }

    [Fact]
    public async Task Create_a_text_poll_returns_label_options()
    {
        var (_, owner, _) = await ProvisionUser("family.use");
        await owner.GetAsync("/api/family/household");

        var res = await owner.PostAsJsonAsync("/api/family/polls", new
        {
            title = "Where to eat?",
            kind = "text",
            options = new[] { new { label = "Pizza" }, new { label = "Tacos" }, new { label = "Sushi" } },
        });
        res.StatusCode.Should().Be(HttpStatusCode.OK);
        var poll = await Json(res);
        poll.GetProperty("kind").GetString().Should().Be("text");
        var options = poll.GetProperty("options");
        options.GetArrayLength().Should().Be(3);
        options[0].GetProperty("label").GetString().Should().Be("Pizza");
        options[0].GetProperty("startUtc").ValueKind.Should().Be(JsonValueKind.Null);
    }

    [Fact]
    public async Task Create_rejects_fewer_than_two_options_and_bad_kind()
    {
        var (_, owner, _) = await ProvisionUser("family.use");
        await owner.GetAsync("/api/family/household");

        (await owner.PostAsJsonAsync("/api/family/polls", new { title = "Solo", kind = "text", options = new[] { new { label = "only" } } }))
            .StatusCode.Should().Be(HttpStatusCode.BadRequest);
        (await owner.PostAsJsonAsync("/api/family/polls", new { title = "Bad", kind = "weird", options = new[] { new { label = "a" }, new { label = "b" } } }))
            .StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    // =====================================================================================
    // VOTE — Doodle-style mark-many + replace
    // =====================================================================================

    [Fact]
    public async Task Vote_records_counts_and_voter_names_no_email_and_marks_my_votes()
    {
        var (_, owner, _) = await ProvisionUser("family.use");
        var (_, _, bobId) = await ProvisionUser("family.use");
        await owner.GetAsync("/api/family/household");
        await owner.PostAsJsonAsync("/api/family/household/members", new { userId = bobId });

        var poll = await CreateTimePoll(owner);
        var pollId = poll.GetProperty("id").GetInt64();
        var opt0 = poll.GetProperty("options")[0].GetProperty("id").GetInt64();
        var opt1 = poll.GetProperty("options")[1].GetProperty("id").GetInt64();

        // Owner marks BOTH options (Doodle: every option that works).
        var voted = await owner.PostAsJsonAsync($"/api/family/polls/{pollId}/vote", new { optionIds = new[] { opt0, opt1 } });
        voted.StatusCode.Should().Be(HttpStatusCode.OK);
        var dto = await Json(voted);

        var options = dto.GetProperty("options");
        options[0].GetProperty("voteCount").GetInt32().Should().Be(1);
        options[1].GetProperty("voteCount").GetInt32().Should().Be(1);
        // The caller's own votes are surfaced.
        dto.GetProperty("myVotes").EnumerateArray().Select(x => x.GetInt64()).Should().BeEquivalentTo(new[] { opt0, opt1 });
        // Voter identity is by name, never email.
        options[0].GetProperty("voters")[0].GetProperty("name").GetString().Should().NotBeNullOrWhiteSpace();
        HasProperty(options[0].GetProperty("voters")[0], "email").Should().BeFalse();
        dto.GetRawText().Should().NotContain("@");
    }

    [Fact]
    public async Task Re_voting_replaces_the_callers_prior_votes_for_that_poll()
    {
        var (_, owner, _) = await ProvisionUser("family.use");
        await owner.GetAsync("/api/family/household");

        var poll = await CreateTimePoll(owner);
        var pollId = poll.GetProperty("id").GetInt64();
        var opt0 = poll.GetProperty("options")[0].GetProperty("id").GetInt64();
        var opt1 = poll.GetProperty("options")[1].GetProperty("id").GetInt64();

        // First vote BOTH, then re-vote only opt1 → opt0 drops to 0, opt1 stays 1.
        await owner.PostAsJsonAsync($"/api/family/polls/{pollId}/vote", new { optionIds = new[] { opt0, opt1 } });
        var dto = await Json(await owner.PostAsJsonAsync($"/api/family/polls/{pollId}/vote", new { optionIds = new[] { opt1 } }));

        var options = dto.GetProperty("options");
        options.EnumerateArray().Single(o => o.GetProperty("id").GetInt64() == opt0).GetProperty("voteCount").GetInt32().Should().Be(0);
        options.EnumerateArray().Single(o => o.GetProperty("id").GetInt64() == opt1).GetProperty("voteCount").GetInt32().Should().Be(1);
        dto.GetProperty("myVotes").EnumerateArray().Select(x => x.GetInt64()).Should().BeEquivalentTo(new[] { opt1 });
    }

    // =====================================================================================
    // CLOSE — default winner is the most-voted
    // =====================================================================================

    [Fact]
    public async Task Close_defaults_to_the_most_voted_option()
    {
        var (_, owner, _) = await ProvisionUser("family.use");
        var (_, _, bobId) = await ProvisionUser("family.use");
        await owner.GetAsync("/api/family/household");
        await owner.PostAsJsonAsync("/api/family/household/members", new { userId = bobId });

        var poll = await CreateTimePoll(owner);
        var pollId = poll.GetProperty("id").GetInt64();
        var opt0 = poll.GetProperty("options")[0].GetProperty("id").GetInt64();
        var opt1 = poll.GetProperty("options")[1].GetProperty("id").GetInt64();

        // Owner votes BOTH; Bob votes only opt1 → opt1 wins (2 vs 1).
        await owner.PostAsJsonAsync($"/api/family/polls/{pollId}/vote", new { optionIds = new[] { opt0, opt1 } });
        var bobClient = Client(await EmailForUser(bobId));
        await bobClient.PostAsJsonAsync($"/api/family/polls/{pollId}/vote", new { optionIds = new[] { opt1 } });

        var closed = await owner.PostAsJsonAsync($"/api/family/polls/{pollId}/close", new { });
        closed.StatusCode.Should().Be(HttpStatusCode.OK);
        var dto = await Json(closed);
        dto.GetProperty("closed").GetBoolean().Should().BeTrue();
        dto.GetProperty("winningOptionId").GetInt64().Should().Be(opt1);
    }

    [Fact]
    public async Task Close_honors_an_explicit_winner()
    {
        var (_, owner, _) = await ProvisionUser("family.use");
        await owner.GetAsync("/api/family/household");

        var poll = await CreateTimePoll(owner);
        var pollId = poll.GetProperty("id").GetInt64();
        var opt0 = poll.GetProperty("options")[0].GetProperty("id").GetInt64();

        var dto = await Json(await owner.PostAsJsonAsync($"/api/family/polls/{pollId}/close", new { winningOptionId = opt0 }));
        dto.GetProperty("winningOptionId").GetInt64().Should().Be(opt0);

        // A closed poll rejects further votes.
        (await owner.PostAsJsonAsync($"/api/family/polls/{pollId}/vote", new { optionIds = new[] { opt0 } }))
            .StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    // =====================================================================================
    // BOOK — text option is a 400; not-connected is graceful 400
    // =====================================================================================

    [Fact]
    public async Task Booking_a_text_option_is_a_bad_request()
    {
        var (_, owner, _) = await ProvisionUser("family.use");
        await owner.GetAsync("/api/family/household");

        var res = await owner.PostAsJsonAsync("/api/family/polls", new
        {
            title = "Dinner spot",
            kind = "text",
            options = new[] { new { label = "Pizza" }, new { label = "Tacos" } },
        });
        var poll = await Json(res);
        var pollId = poll.GetProperty("id").GetInt64();
        var optId = poll.GetProperty("options")[0].GetProperty("id").GetInt64();

        (await owner.PostAsJsonAsync($"/api/family/polls/{pollId}/book", new { optionId = optId }))
            .StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task Booking_a_time_option_when_not_connected_degrades_to_bad_request_not_500()
    {
        var (_, owner, _) = await ProvisionUser("family.use");
        await owner.GetAsync("/api/family/household");

        var poll = await CreateTimePoll(owner);
        var pollId = poll.GetProperty("id").GetInt64();
        var optId = poll.GetProperty("options")[0].GetProperty("id").GetInt64();

        // No connected (and no configured) calendar in tests → graceful 400, never a 500.
        var res = await owner.PostAsJsonAsync($"/api/family/polls/{pollId}/book", new { optionId = optId });
        res.StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    // =====================================================================================
    // CROSS-HOUSEHOLD ISOLATION
    // =====================================================================================

    [Fact]
    public async Task Cross_household_isolation_each_family_sees_and_touches_only_its_own_polls()
    {
        var (_, alice, _) = await ProvisionUser("family.use");
        var (_, bob, _) = await ProvisionUser("family.use");
        await alice.GetAsync("/api/family/household");
        await bob.GetAsync("/api/family/household");

        var alicePoll = await CreateTimePoll(alice);
        var alicePollId = alicePoll.GetProperty("id").GetInt64();

        // Bob can't see Alice's poll.
        (await Json(await bob.GetAsync("/api/family/polls"))).EnumerateArray()
            .Select(x => x.GetProperty("id").GetInt64()).Should().NotContain(alicePollId);

        // ...and can't reach into it (404, existence never leaked).
        var aliceOpt = alicePoll.GetProperty("options")[0].GetProperty("id").GetInt64();
        (await bob.PostAsJsonAsync($"/api/family/polls/{alicePollId}/vote", new { optionIds = new[] { aliceOpt } }))
            .StatusCode.Should().Be(HttpStatusCode.NotFound);
        (await bob.PostAsJsonAsync($"/api/family/polls/{alicePollId}/close", new { }))
            .StatusCode.Should().Be(HttpStatusCode.NotFound);
        (await bob.DeleteAsync($"/api/family/polls/{alicePollId}")).StatusCode.Should().Be(HttpStatusCode.NotFound);
    }

    [Fact]
    public async Task Delete_removes_a_poll()
    {
        var (_, owner, _) = await ProvisionUser("family.use");
        await owner.GetAsync("/api/family/household");
        var poll = await CreateTimePoll(owner);
        var pollId = poll.GetProperty("id").GetInt64();

        (await owner.DeleteAsync($"/api/family/polls/{pollId}")).StatusCode.Should().Be(HttpStatusCode.NoContent);
        (await Json(await owner.GetAsync("/api/family/polls"))).EnumerateArray()
            .Select(x => x.GetProperty("id").GetInt64()).Should().NotContain(pollId);
    }

    // =====================================================================================
    // AI POLL OPTIONS — gated by family.use, 400 on empty, graceful 503 when Gemini unconfigured,
    // and writes NOTHING (no poll is created)
    // =====================================================================================

    [Fact]
    public async Task PollOptionsAi_requires_family_use()
    {
        var (_, plain, _) = await ProvisionUser("dashboard.view");
        var res = await plain.PostAsJsonAsync("/api/family/polls/ai/options",
            new { prompt = "dinner out next weekend", kind = "time" });
        res.StatusCode.Should().Be(HttpStatusCode.Forbidden);
    }

    [Fact]
    public async Task PollOptionsAi_requires_authentication()
    {
        var anon = factory.CreateClient();
        var res = await anon.PostAsJsonAsync("/api/family/polls/ai/options",
            new { prompt = "dinner out next weekend", kind = "time" });
        res.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task PollOptionsAi_returns_400_for_empty_prompt()
    {
        var (_, owner, _) = await ProvisionUser("family.use");
        await owner.GetAsync("/api/family/household");

        var res = await owner.PostAsJsonAsync("/api/family/polls/ai/options", new { prompt = "   ", kind = "text" });
        res.StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task PollOptionsAi_is_unavailable_503_when_gemini_is_unconfigured_never_500()
    {
        var (_, owner, _) = await ProvisionUser("family.use");
        await owner.GetAsync("/api/family/household");

        // No Gemini API key in the test host → graceful 503 (never a 500, never a real model call).
        var res = await owner.PostAsJsonAsync("/api/family/polls/ai/options",
            new { prompt = "where should we go on holiday", kind = "text" });
        res.StatusCode.Should().Be(HttpStatusCode.ServiceUnavailable);
    }

    [Fact]
    public async Task PollOptionsAi_creates_nothing()
    {
        var (_, owner, _) = await ProvisionUser("family.use");
        await owner.GetAsync("/api/family/household");

        // The call is unavailable in tests (no Gemini), but it must NEVER create a poll regardless.
        await owner.PostAsJsonAsync("/api/family/polls/ai/options",
            new { prompt = "movie night this weekend", kind = "time" });

        var polls = await Json(await owner.GetAsync("/api/family/polls"));
        polls.GetArrayLength().Should().Be(0);
    }

    // =====================================================================================
    // AI POLL SUMMARY — ALWAYS 200 with a deterministic plain floor (never 503), 404 for a foreign poll
    // =====================================================================================

    [Fact]
    public async Task PollSummaryAi_requires_family_use()
    {
        var (_, plain, _) = await ProvisionUser("dashboard.view");
        (await plain.GetAsync("/api/family/polls/1/ai/summary")).StatusCode.Should().Be(HttpStatusCode.Forbidden);
    }

    [Fact]
    public async Task PollSummaryAi_requires_authentication()
    {
        var anon = factory.CreateClient();
        (await anon.GetAsync("/api/family/polls/1/ai/summary")).StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task PollSummaryAi_falls_back_to_a_plain_summary_when_gemini_unconfigured_never_503()
    {
        var (_, owner, _) = await ProvisionUser("family.use");
        await owner.GetAsync("/api/family/household");

        var poll = await CreateTimePoll(owner);
        var pollId = poll.GetProperty("id").GetInt64();
        var opt0 = poll.GetProperty("options")[0].GetProperty("id").GetInt64();
        await owner.PostAsJsonAsync($"/api/family/polls/{pollId}/vote", new { optionIds = new[] { opt0 } });

        // No Gemini in tests → ALWAYS 200 with the deterministic plain floor (fellBackToPlain=true), never 503.
        var res = await owner.GetAsync($"/api/family/polls/{pollId}/ai/summary");
        res.StatusCode.Should().Be(HttpStatusCode.OK);
        var dto = await Json(res);
        dto.GetProperty("fellBackToPlain").GetBoolean().Should().BeTrue();
        dto.GetProperty("summary").GetString().Should().NotBeNullOrWhiteSpace();
        // The plain floor names the poll + its standing; never an email.
        dto.GetProperty("summary").GetString().Should().Contain("Movie night");
        dto.GetRawText().Should().NotContain("@");
    }

    [Fact]
    public async Task PollSummaryAi_is_404_for_a_foreign_poll()
    {
        var (_, alice, _) = await ProvisionUser("family.use");
        var (_, bob, _) = await ProvisionUser("family.use");
        await alice.GetAsync("/api/family/household");
        await bob.GetAsync("/api/family/household");

        var alicePoll = await CreateTimePoll(alice);
        var alicePollId = alicePoll.GetProperty("id").GetInt64();

        // Bob cannot summarise Alice's poll — 404 (existence never leaked, honours household scope).
        (await bob.GetAsync($"/api/family/polls/{alicePollId}/ai/summary"))
            .StatusCode.Should().Be(HttpStatusCode.NotFound);
    }

    /// <summary>Resolve a user's email from the DB so we can build their client (email never on the wire).</summary>
    private async Task<string> EmailForUser(int userId)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<UsageDbContext>();
        return await db.Users.AsNoTracking().Where(u => u.Id == userId).Select(u => u.Email).FirstAsync();
    }
}
