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
/// The Slice 2 meal-macro ESTIMATE in <see cref="GeminiService.EstimateMealMacrosAsync"/>, exercised against a
/// stubbed Gemini HTTP response so the SERVER-SIDE clamp logic is covered without a live key:
///
/// <list type="bullet">
///   <item>a well-formed model reply maps to the dish TOTALS + suggested servings + note verbatim;</item>
///   <item>absurd/negative model numbers are CLAMPED to the dish-total ceilings (cal 0..20000, macros 0..2000,
///   servings 1..50) — a hostile reply can never inject out-of-range values;</item>
///   <item>empty title+ingredients short-circuits to null without any HTTP call.</item>
/// </list>
/// (Gating/auth/household-scope/503/proposal-not-saved are covered at the endpoint level in the integration
/// tests; an unconfigured key short-circuits to null there, so the clamp logic itself is unit-tested here.)
/// </summary>
public class GeminiMealMacrosTests
{
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

    private static GeminiService ServiceReturning(string modelJson) =>
        new(new StubFactory(new StubHandler(modelJson)),
            Options.Create(new GeminiOptions { ApiKey = "test-key", Model = "gemini-2.5-flash" }),
            new MemoryCache(new MemoryCacheOptions()),
            NullLogger<GeminiService>.Instance);

    [Fact]
    public async Task EstimateMealMacros_maps_dish_totals_servings_and_note()
    {
        var modelJson = JsonSerializer.Serialize(new
        {
            calories = 3200,
            protein_g = 180.5,
            carbs_g = 240.2,
            fat_g = 110.9,
            servings = 6,
            note = "Assumed lean beef.",
        });

        var result = await ServiceReturning(modelJson).EstimateMealMacrosAsync("Lasagne", "beef\npasta\ncheese");

        result.Should().NotBeNull();
        result!.Calories.Should().Be(3200);
        result.ProteinG.Should().Be(180.5);
        result.CarbG.Should().Be(240.2);
        result.FatG.Should().Be(110.9);
        result.Servings.Should().Be(6);
        result.Note.Should().Be("Assumed lean beef.");
    }

    [Fact]
    public async Task EstimateMealMacros_clamps_out_of_range_numbers()
    {
        // A hostile/garbage reply: absurd totals, negative macro, zero servings.
        var modelJson = JsonSerializer.Serialize(new
        {
            calories = 9_999_999,   // > 20000 ceiling
            protein_g = -50,        // negative → 0
            carbs_g = 50_000,       // > 2000 ceiling
            fat_g = 30,
            servings = 0,           // < 1 → 1
            note = "",
        });

        var result = await ServiceReturning(modelJson).EstimateMealMacrosAsync("X", "y");

        result.Should().NotBeNull();
        result!.Calories.Should().Be(20000);
        result.ProteinG.Should().Be(0);
        result.CarbG.Should().Be(2000);
        result.FatG.Should().Be(30);
        result.Servings.Should().Be(1);
    }

    [Fact]
    public async Task EstimateMealMacros_clamps_servings_to_50()
    {
        var modelJson = JsonSerializer.Serialize(new
        {
            calories = 1000, protein_g = 10, carbs_g = 10, fat_g = 10, servings = 9999, note = "",
        });

        var result = await ServiceReturning(modelJson).EstimateMealMacrosAsync("Big batch", "rice");

        result!.Servings.Should().Be(50);
    }

    [Fact]
    public async Task EstimateMealMacros_returns_null_for_empty_title_and_ingredients()
    {
        // No HTTP call should be needed — empty input short-circuits to null.
        var result = await ServiceReturning("{}").EstimateMealMacrosAsync("   ", "  ");
        result.Should().BeNull();
    }
}
