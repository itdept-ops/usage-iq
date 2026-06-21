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
/// The "Plan our week" + "From a recipe" model-output handling in <see cref="GeminiService"/>, exercised
/// against a stubbed Gemini HTTP response so the SERVER-SIDE drop/clamp logic is covered without a live key:
///
/// <list type="bullet">
///   <item>plan-week DROPS any meal whose local_date is not one of the requested slot dates, and CLAMPS the
///   result to at most 7 meals.</item>
///   <item>plan-week FORCES slot="dinner" regardless of what the model returns, and clamps each ingredients
///   blob to a de-duped, bullet-stripped, ~20-line newline list.</item>
///   <item>from-recipe returns the parsed title + newline-joined ingredient lines (bullets stripped).</item>
/// </list>
///
/// (Gating/auth/empty-input/503 are covered at the endpoint level in the integration tests; an unconfigured
/// key short-circuits to null there, so the drop/clamp logic itself is unit-tested here.)
/// </summary>
public class GeminiMealPlannerTests
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

    private static GeminiService ServiceReturning(string modelJson)
    {
        var opts = Options.Create(new GeminiOptions { ApiKey = "test-key", Model = "gemini-2.5-flash" });
        return new GeminiService(
            new StubFactory(new StubHandler(modelJson)),
            opts,
            new MemoryCache(new MemoryCacheOptions()),
            NullLogger<GeminiService>.Instance);
    }

    // =====================================================================================
    // PLAN OUR WEEK — drop off-date meals, clamp count, force slot, clamp ingredients
    // =====================================================================================

    [Fact]
    public async Task PlanWeek_drops_meals_whose_date_is_not_a_requested_slot()
    {
        var monday = new DateOnly(2026, 6, 22);
        var tuesday = monday.AddDays(1);
        var wanted = new[] { monday, tuesday };

        // The model returns 3 meals: two on the requested dates, one on an UNREQUESTED date (must be dropped).
        var modelJson = JsonSerializer.Serialize(new
        {
            meals = new object[]
            {
                new { local_date = "2026-06-22", slot = "dinner", title = "Tacos", ingredients = "tortillas\nbeef" },
                new { local_date = "2026-06-23", slot = "dinner", title = "Stir-fry", ingredients = "rice\nveg" },
                new { local_date = "2026-06-29", slot = "dinner", title = "Off-week pizza", ingredients = "dough" },
            },
            notes = "",
        });

        var result = await ServiceReturning(modelJson)
            .PlanWeekAsync("kid-friendly", wanted, Array.Empty<string>());

        result.Should().NotBeNull();
        result!.Meals.Should().HaveCount(2);
        result.Meals.Select(m => m.LocalDate).Should().BeEquivalentTo(new[] { monday, tuesday });
        result.Meals.Select(m => m.Title).Should().NotContain("Off-week pizza");
    }

    [Fact]
    public async Task PlanWeek_clamps_to_at_most_7_and_forces_dinner_slot()
    {
        // Request all 7 dinner dates; the model returns 9 (two on extra dates) with a WRONG slot on each.
        var monday = new DateOnly(2026, 6, 22);
        var wanted = Enumerable.Range(0, 7).Select(monday.AddDays).ToArray();

        var meals = wanted.Select((d, i) => (object)new
        {
            local_date = d.ToString("yyyy-MM-dd"),
            slot = "lunch", // wrong on purpose — must be forced to "dinner"
            title = $"Dinner {i}",
            ingredients = "stuff",
        }).Concat(new object[]
        {
            new { local_date = "2026-07-06", slot = "dinner", title = "Extra A", ingredients = "x" },
            new { local_date = "2026-07-07", slot = "dinner", title = "Extra B", ingredients = "y" },
        }).ToArray();

        var modelJson = JsonSerializer.Serialize(new { meals, notes = "" });

        var result = await ServiceReturning(modelJson).PlanWeekAsync(null, wanted, Array.Empty<string>());

        result.Should().NotBeNull();
        result!.Meals.Should().HaveCountLessThanOrEqualTo(7);
        result.Meals.Should().OnlyContain(m => m.Slot == "dinner");
        result.Meals.Select(m => m.LocalDate).Should().OnlyContain(d => wanted.Contains(d));
    }

    [Fact]
    public async Task PlanWeek_clamps_ingredients_to_a_deduped_bulletfree_newline_list()
    {
        var monday = new DateOnly(2026, 6, 22);
        var wanted = new[] { monday };

        var modelJson = JsonSerializer.Serialize(new
        {
            meals = new object[]
            {
                new
                {
                    local_date = "2026-06-22",
                    slot = "dinner",
                    title = "Spaghetti",
                    ingredients = "- pasta\n1. tomato sauce\n* parmesan\npasta\n\n",
                },
            },
            notes = "",
        });

        var result = await ServiceReturning(modelJson).PlanWeekAsync(null, wanted, Array.Empty<string>());

        var lines = result!.Meals.Single().Ingredients.Split('\n');
        lines.Should().Equal("pasta", "tomato sauce", "parmesan"); // bullets stripped, blank + dup dropped
    }

    [Fact]
    public async Task PlanWeek_with_no_slot_dates_returns_empty_without_calling_the_model()
    {
        // A handler that would THROW if hit proves no model call is made when there are no slots to fill.
        var opts = Options.Create(new GeminiOptions { ApiKey = "test-key" });
        var svc = new GeminiService(
            new StubFactory(new ThrowingHandler()), opts,
            new MemoryCache(new MemoryCacheOptions()), NullLogger<GeminiService>.Instance);

        var result = await svc.PlanWeekAsync("anything", Array.Empty<DateOnly>(), Array.Empty<string>());

        result.Should().NotBeNull();
        result!.Meals.Should().BeEmpty();
    }

    private sealed class ThrowingHandler : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct) =>
            throw new InvalidOperationException("the model must not be called when there are no slots to fill");
    }

    // =====================================================================================
    // FROM A RECIPE — title + newline-joined ingredient lines
    // =====================================================================================

    [Fact]
    public async Task RecipeToMeal_returns_title_and_bulletfree_ingredient_lines()
    {
        var modelJson = JsonSerializer.Serialize(new
        {
            title = "Banana Bread",
            ingredients = "- 2 bananas\n- 1 cup flour\n* 1/2 cup sugar",
            notes = "",
        });

        var result = await ServiceReturning(modelJson).RecipeToMealAsync("paste of a banana bread recipe...");

        result.Should().NotBeNull();
        result!.Title.Should().Be("Banana Bread");
        result.Ingredients.Split('\n').Should().Equal("2 bananas", "1 cup flour", "1/2 cup sugar");
    }

    [Fact]
    public async Task RecipeToMeal_returns_null_for_empty_text_without_calling_the_model()
    {
        var opts = Options.Create(new GeminiOptions { ApiKey = "test-key" });
        var svc = new GeminiService(
            new StubFactory(new ThrowingHandler()), opts,
            new MemoryCache(new MemoryCacheOptions()), NullLogger<GeminiService>.Instance);

        (await svc.RecipeToMealAsync("   ")).Should().BeNull();
    }
}
