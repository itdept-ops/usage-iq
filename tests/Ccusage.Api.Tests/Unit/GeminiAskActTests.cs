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
/// The "Ask that Acts" model-output handling in <see cref="GeminiService.AskActAsync"/>, exercised against a
/// stubbed Gemini HTTP response so the SERVER-SIDE drop/clamp logic is covered without a live key (a clone of
/// <see cref="GeminiFamilyAssistantTests"/>):
///
/// <list type="bullet">
///   <item>actions whose <c>type</c> is OUTSIDE the closed enum (calendar_event/grocery_add/meal/goal_tweak/
///   tracker_log/reminder/timer/note) are DROPPED, and NO finance write is ever accepted;</item>
///   <item>actions whose REQUIRED params are missing/empty are DROPPED;</item>
///   <item>numeric/string clamps + closed-vocabulary normalisation hold (timer 5..86400, goal lose/maintain/gain,
///   tracker_log kind, grocery items de-dupe/cap);</item>
///   <item>the answer is carried through, and an empty question returns null without calling the model.</item>
/// </list>
/// </summary>
public class GeminiAskActTests
{
    private sealed class StubHandler(string modelJson) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            var envelope = new
            {
                candidates = new[] { new { content = new { parts = new[] { new { text = modelJson } } } } },
            };
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(JsonSerializer.Serialize(envelope), Encoding.UTF8, "application/json"),
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
            throw new InvalidOperationException("the model must not be called");
    }

    private static GeminiService ServiceReturning(string modelJson) => new(
        new StubFactory(new StubHandler(modelJson)),
        Options.Create(new GeminiOptions { ApiKey = "test-key", Model = "gemini-2.5-flash" }),
        new MemoryCache(new MemoryCacheOptions()),
        NullLogger<GeminiService>.Instance);

    private static GeminiService ServiceThatMustNotCall() => new(
        new StubFactory(new ThrowingHandler()),
        Options.Create(new GeminiOptions { ApiKey = "test-key" }),
        new MemoryCache(new MemoryCacheOptions()),
        NullLogger<GeminiService>.Instance);

    private static readonly TimeZoneInfo Tz = TimeZoneInfo.Utc;
    private static readonly DateTime Ref = new(2026, 6, 21, 9, 0, 0, DateTimeKind.Unspecified);

    private static T? Get<T>(IReadOnlyDictionary<string, object?> p, string key) =>
        p.TryGetValue(key, out var v) && v is T t ? t : default;

    [Fact]
    public async Task AskAct_returns_null_for_an_empty_question_without_calling_the_model()
    {
        (await ServiceThatMustNotCall().AskActAsync("(snapshot)", "   ", Ref, Tz))
            .Should().BeNull();
    }

    [Fact]
    public async Task Out_of_enum_action_types_and_finance_writes_are_dropped()
    {
        var modelJson = JsonSerializer.Serialize(new
        {
            answer = "Sure.",
            actions = new object[]
            {
                new { type = "finance_write", title = "Pay a bill", @params = new { amount = 50 } }, // not in the set
                new { type = "list_add", title = "borrowed family type", @params = new { listName = "x", items = new[] { "y" } } }, // not in THIS set
                new { type = "TIMER", title = "Oven", @params = new { label = "Oven", durationSeconds = 600 } }, // valid (case-insensitive)
            },
        });

        var result = await ServiceReturning(modelJson).AskActAsync("(s)", "x", Ref, Tz);

        result.Should().NotBeNull();
        result!.Answer.Should().Be("Sure.");
        result.Actions.Should().HaveCount(1);
        result.Actions[0].Type.Should().Be("timer");
    }

    [Fact]
    public async Task Actions_missing_required_params_are_dropped()
    {
        var modelJson = JsonSerializer.Serialize(new
        {
            answer = "",
            actions = new object[]
            {
                new { type = "grocery_add", title = "no items", @params = new { items = Array.Empty<string>() } },            // empty -> drop
                new { type = "calendar_event", title = "no start", @params = new { title = "Dentist", startLocal = "" } },   // no start -> drop
                new { type = "meal", title = "no title", @params = new { title = "", ingredients = "x" } },                  // blank title -> drop
                new { type = "goal_tweak", title = "nothing", @params = new { goal = "", activityLevel = "", targetWeightKg = 0 } }, // nothing to tweak -> drop
                new { type = "tracker_log", title = "bad kind", @params = new { kind = "mood", description = "happy" } },     // unknown kind -> drop
                new { type = "tracker_log", title = "no desc", @params = new { kind = "food", description = "  " } },         // blank desc -> drop
                new { type = "reminder", title = "no text", @params = new { text = "  " } },                                 // blank text -> drop
                new { type = "note", title = "no text", @params = new { text = "" } },                                       // blank text -> drop
            },
        });

        var result = await ServiceReturning(modelJson).AskActAsync("(s)", "x", Ref, Tz);

        result.Should().NotBeNull();
        result!.Actions.Should().BeEmpty();
    }

    [Fact]
    public async Task Each_valid_action_type_maps_and_clamps()
    {
        var modelJson = JsonSerializer.Serialize(new
        {
            answer = "On it.",
            actions = new object[]
            {
                new { type = "calendar_event", title = "Dentist", @params = new { title = "Dentist", startLocal = "2026-06-23T16:00:00", endLocal = "2026-06-23T17:00:00", allDay = false } },
                new { type = "grocery_add", title = "Add", @params = new { items = new[] { "Milk", "milk", "Eggs" } } }, // dupe dropped
                new { type = "meal", title = "Tacos", @params = new { title = "Tacos", ingredients = "tortillas\nbeef", mealDateLocal = "2026-06-26" } },
                new { type = "goal_tweak", title = "Goal", @params = new { goal = "LOSE", activityLevel = "very active", targetWeightKg = 80.27 } },
                new { type = "tracker_log", title = "Log", @params = new { kind = "FOOD", description = "2 eggs and toast", dateLocal = "2026-06-21" } },
                new { type = "timer", title = "Pasta", @params = new { label = "", durationSeconds = 1 } }, // below floor -> 5; blank -> "Timer"
            },
        });

        var result = await ServiceReturning(modelJson).AskActAsync("(s)", "x", Ref, Tz);

        result.Should().NotBeNull();
        result!.Answer.Should().Be("On it.");
        result.Actions.Should().HaveCount(6);

        var grocery = result.Actions.Single(a => a.Type == "grocery_add");
        ((System.Collections.IEnumerable)grocery.Params["items"]!).Cast<string>().Should().Equal("Milk", "Eggs");

        var ev = result.Actions.Single(a => a.Type == "calendar_event");
        Get<string>(ev.Params, "startLocal").Should().Be("2026-06-23T16:00:00");

        var meal = result.Actions.Single(a => a.Type == "meal");
        Get<string>(meal.Params, "mealDateLocal").Should().Be("2026-06-26"); // bare date kept

        var goal = result.Actions.Single(a => a.Type == "goal_tweak");
        Get<string>(goal.Params, "goal").Should().Be("lose");                 // normalised
        Get<string>(goal.Params, "activityLevel").Should().Be("very_active"); // normalised
        Convert.ToDouble(goal.Params["targetWeightKg"]).Should().Be(80.3);    // rounded to 0.1

        var log = result.Actions.Single(a => a.Type == "tracker_log");
        Get<string>(log.Params, "kind").Should().Be("food");                  // normalised
        Get<string>(log.Params, "description").Should().Be("2 eggs and toast");

        var timer = result.Actions.Single(a => a.Type == "timer");
        Convert.ToInt32(timer.Params["durationSeconds"]).Should().Be(5);
        Get<string>(timer.Params, "label").Should().Be("Timer");
    }

    [Fact]
    public async Task At_most_six_actions_are_kept()
    {
        var actions = Enumerable.Range(0, 10).Select(i => (object)new
        {
            type = "timer",
            title = $"Timer {i}",
            @params = new { label = $"T{i}", durationSeconds = 300 },
        }).ToArray();
        var modelJson = JsonSerializer.Serialize(new { answer = "", actions });

        var result = await ServiceReturning(modelJson).AskActAsync("(s)", "x", Ref, Tz);

        result.Should().NotBeNull();
        result!.Actions.Should().HaveCount(6);
    }

    [Fact]
    public async Task A_garbage_local_time_param_is_normalised_to_empty()
    {
        var modelJson = JsonSerializer.Serialize(new
        {
            answer = "",
            actions = new object[]
            {
                new { type = "reminder", title = "Remind", @params = new { text = "Water plants", whenLocal = "not-a-date" } },
            },
        });

        var result = await ServiceReturning(modelJson).AskActAsync("(s)", "x", Ref, Tz);

        result.Should().NotBeNull();
        var reminder = result!.Actions.Single();
        Get<string>(reminder.Params, "whenLocal").Should().Be(""); // unparseable -> ""
    }
}
