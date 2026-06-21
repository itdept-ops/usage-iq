using System.Net;
using System.Text;
using System.Text.Json;
using Ccusage.Api.Services;
using FluentAssertions;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;

namespace Ccusage.Api.Tests.Unit;

/// <summary>
/// Family Hub slice 5 (Calendar + Polls) AI parsing in <see cref="GeminiService"/>, exercised against a
/// stubbed Gemini HTTP response so the SERVER-SIDE clamp/normalise logic is covered without a live key:
///
/// <list type="bullet">
///   <item>ParseFindTimeAsync CLAMPS the interpreted form: duration into [1, 1440] (default 60 when
///   missing/non-positive), the search window non-empty and capped at 366 days, dayStart into [0, 23] and
///   dayEnd strictly greater than dayStart — no matter what the model returns.</item>
///   <item>PollOptionsAsync honours an explicit kind, resolves time options local→UTC + clamps their
///   duration, caps the option count at 30, and falls back to short text labels.</item>
///   <item>Every method short-circuits to null when unconfigured / on empty input (no model call).</item>
/// </list>
///
/// (Gating/auth/empty-input/503-or-plain-floor are covered at the endpoint level in the integration tests;
/// the clamp/normalise logic itself is unit-tested here.)
/// </summary>
public class GeminiCalendarPollsTests
{
    /// <summary>An HttpMessageHandler that returns one canned Gemini generateContent response whose single
    /// candidate text is the supplied strict-JSON model payload.</summary>
    private sealed class StubHandler(string modelJson) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            var envelope = new
            {
                candidates = new[]
                {
                    new { content = new { parts = new[] { new { text = modelJson } } } },
                },
            };
            var body = JsonSerializer.Serialize(envelope);
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(body, Encoding.UTF8, "application/json"),
            });
        }
    }

    private sealed class StubFactory(HttpMessageHandler handler) : IHttpClientFactory
    {
        public HttpClient CreateClient(string name) =>
            new(handler, disposeHandler: false) { BaseAddress = new Uri("https://generativelanguage.googleapis.com") };
    }

    private sealed class ThrowingHandler : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct) =>
            throw new InvalidOperationException("the model must not be called for empty/unconfigured input");
    }

    private static GeminiService ServiceReturning(string modelJson) =>
        new(new StubFactory(new StubHandler(modelJson)),
            Options.Create(new GeminiOptions { ApiKey = "test-key", Model = "gemini-2.5-flash" }),
            new MemoryCache(new MemoryCacheOptions()),
            NullLogger<GeminiService>.Instance);

    private static GeminiService UnconfiguredService() =>
        new(new StubFactory(new ThrowingHandler()),
            Options.Create(new GeminiOptions { ApiKey = null }),
            new MemoryCache(new MemoryCacheOptions()),
            NullLogger<GeminiService>.Instance);

    private static GeminiService ThrowingIfCalledService() =>
        new(new StubFactory(new ThrowingHandler()),
            Options.Create(new GeminiOptions { ApiKey = "test-key" }),
            new MemoryCache(new MemoryCacheOptions()),
            NullLogger<GeminiService>.Instance);

    private static readonly TimeZoneInfo Utc = TimeZoneInfo.Utc;
    private static readonly DateTime Reference = new(2026, 6, 22, 12, 0, 0, DateTimeKind.Utc); // Mon noon UTC

    // =====================================================================================
    // FIND-TIME — interpreted form is clamped (duration 1..1440, window <=366d, day bounds)
    // =====================================================================================

    [Fact]
    public async Task FindTime_clamps_duration_window_and_day_bounds_from_an_out_of_range_model_reply()
    {
        // The model returns absurd values: a 99,999-min duration, a window spanning ~3 years, and a dayEnd
        // BELOW dayStart. Every value must be clamped.
        var modelJson = JsonSerializer.Serialize(new
        {
            duration_minutes = 99999,
            from_local = "2026-06-23T00:00:00",
            to_local = "2029-06-23T00:00:00", // ~3 years later — must be capped to <=366 days
            day_start_hour = 8,
            day_end_hour = 3, // below start — must be corrected to > start
            note = "mornings next week",
        });

        var result = await ServiceReturning(modelJson).ParseFindTimeAsync("a slot next week, mornings", Reference, Utc);

        result.Should().NotBeNull();
        result!.DurationMinutes.Should().Be(1440); // clamped to the 24h max
        result.DayStartHourLocal.Should().Be(8);
        result.DayEndHourLocal.Should().BeGreaterThan(result.DayStartHourLocal);
        (result.ToUtc - result.FromUtc).Should().BeLessThanOrEqualTo(TimeSpan.FromDays(366));
        result.ToUtc.Should().BeAfter(result.FromUtc);
    }

    [Fact]
    public async Task FindTime_defaults_duration_to_60_and_window_to_a_sane_horizon_when_missing()
    {
        // The model omits the duration and the window entirely.
        var modelJson = JsonSerializer.Serialize(new { note = "" });

        var result = await ServiceReturning(modelJson).ParseFindTimeAsync("find us a time", Reference, Utc);

        result.Should().NotBeNull();
        result!.DurationMinutes.Should().Be(60);          // default
        result.FromUtc.Should().Be(Reference);            // defaults to the reference
        result.ToUtc.Should().BeAfter(result.FromUtc);    // non-empty window
        (result.ToUtc - result.FromUtc).Should().BeLessThanOrEqualTo(TimeSpan.FromDays(366));
        result.DayStartHourLocal.Should().Be(9);          // default workday
        result.DayEndHourLocal.Should().Be(17);
    }

    [Fact]
    public async Task FindTime_returns_null_for_empty_text_and_when_unconfigured_without_calling_the_model()
    {
        (await ThrowingIfCalledService().ParseFindTimeAsync("   ", Reference, Utc)).Should().BeNull();
        (await UnconfiguredService().ParseFindTimeAsync("a slot next week", Reference, Utc)).Should().BeNull();
    }

    // =====================================================================================
    // POLL OPTIONS — honour kind, resolve time local→UTC, cap count, text labels
    // =====================================================================================

    [Fact]
    public async Task PollOptions_time_resolves_slots_and_caps_at_30()
    {
        // 32 time options returned — must be capped to 30; each resolved to UTC with a clamped duration.
        var options = Enumerable.Range(0, 32).Select(i => (object)new
        {
            start_local = new DateTime(2026, 6, 27).AddHours(18 + i % 4).ToString("yyyy-MM-ddTHH:mm:ss"),
            end_local = new DateTime(2026, 6, 27).AddHours(20 + i % 4).ToString("yyyy-MM-ddTHH:mm:ss"),
        }).ToArray();
        var modelJson = JsonSerializer.Serialize(new { kind = "time", options });

        var result = await ServiceReturning(modelJson).PollOptionsAsync("movie night", "time", Reference, Utc);

        result.Should().NotBeNull();
        result!.Kind.Should().Be("time");
        result.TimeOptions.Should().HaveCountLessThanOrEqualTo(30);
        result.TimeOptions.Should().OnlyContain(o => o.EndUtc > o.StartUtc);
        result.TextOptions.Should().BeEmpty();
    }

    [Fact]
    public async Task PollOptions_honours_an_explicit_text_kind_even_if_the_model_says_time()
    {
        // The caller forced "text"; the model wrongly claims "time" — we follow the CALLER and read labels.
        var modelJson = JsonSerializer.Serialize(new
        {
            kind = "time",
            options = new object[]
            {
                new { label = "Pizza" },
                new { label = "Tacos" },
                new { label = "Sushi" },
            },
        });

        var result = await ServiceReturning(modelJson).PollOptionsAsync("where to eat", "text", Reference, Utc);

        result.Should().NotBeNull();
        result!.Kind.Should().Be("text");
        result.TextOptions.Should().Equal("Pizza", "Tacos", "Sushi");
        result.TimeOptions.Should().BeEmpty();
    }

    [Fact]
    public async Task PollOptions_returns_null_for_empty_prompt_and_when_unconfigured_without_calling_the_model()
    {
        (await ThrowingIfCalledService().PollOptionsAsync("   ", "text", Reference, Utc)).Should().BeNull();
        (await UnconfiguredService().PollOptionsAsync("dinner out", "time", Reference, Utc)).Should().BeNull();
    }

    // =====================================================================================
    // POLL SUMMARY — narrates, but returns null (so the endpoint floors to plain) when unconfigured/empty
    // =====================================================================================

    [Fact]
    public async Task PollSummary_returns_the_model_narrative_when_configured()
    {
        var modelJson = JsonSerializer.Serialize(new { summary = "Tuesday is in the lead with 3 votes." });

        var result = await ServiceReturning(modelJson).PollSummaryAsync("title: Movie night\nstatus: open");

        result.Should().Be("Tuesday is in the lead with 3 votes.");
    }

    [Fact]
    public async Task PollSummary_returns_null_for_empty_facts_and_when_unconfigured_without_calling_the_model()
    {
        (await ThrowingIfCalledService().PollSummaryAsync("   ")).Should().BeNull();
        (await UnconfiguredService().PollSummaryAsync("title: X")).Should().BeNull();
    }
}
