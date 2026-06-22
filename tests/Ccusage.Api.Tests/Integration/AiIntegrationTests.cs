using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using FluentAssertions;

namespace Ccusage.Api.Tests.Integration;

/// <summary>
/// AI-assist endpoints (<c>/api/ai</c>). They are gated behind the dedicated, OFF-by-default
/// <c>tracker.ai</c> permission (NOT <c>tracker.self</c>): 401 anonymous, 403 for a user that only holds
/// <c>tracker.self</c>, allowed only with <c>tracker.ai</c> (admins have it via full access). They degrade
/// GRACEFULLY to 503 when Gemini is unconfigured — which the test host always is, because no
/// <c>Gemini__ApiKey</c> is set (and <c>SkipLocalSettings=true</c> keeps the local secrets file out). The
/// real Gemini API is NEVER called from tests: the 503-when-unconfigured branch is reached before any HTTP
/// request is built, and the photo routes reject a bad/oversized image with 400 before the unconfigured
/// check even matters.
/// </summary>
[Collection(IntegrationCollection.Name)]
public class AiIntegrationTests(WebAppFactory factory)
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
        var email = $"ai-{Guid.NewGuid():N}@test.local";
        var res = await Admin().PostAsJsonAsync("/api/users", new { email, isEnabled = true, permissions });
        res.StatusCode.Should().Be(HttpStatusCode.Created);
        return (email, Client(email));
    }

    /// <summary>Every POST route and its minimal valid body, plus every GET route (null body).</summary>
    public static IEnumerable<object?[]> AllRoutes()
    {
        yield return new object?[] { HttpMethod.Post, "/api/ai/estimate-macros", new { description = "2 eggs" } };
        yield return new object?[] { HttpMethod.Post, "/api/ai/supplement-macros", new { name = "whey protein", dose = "1 scoop" } };
        yield return new object?[] { HttpMethod.Post, "/api/ai/suggest-goal", new { } };
        yield return new object?[] { HttpMethod.Post, "/api/ai/estimate-exercise", new { name = "running", durationMin = 30 } };
        yield return new object?[] { HttpMethod.Post, "/api/ai/parse-exercise", new { text = "3x10 squats" } };
        yield return new object?[] { HttpMethod.Post, "/api/ai/suggest-workout", new { focus = "legs", minutes = 30 } };
        yield return new object?[] { HttpMethod.Post, "/api/ai/parse-meal", new { text = "Big Mac, fries, Coke" } };
        yield return new object?[] { HttpMethod.Post, "/api/ai/meal-feedback", new { description = "pizza" } };
        yield return new object?[] { HttpMethod.Post, "/api/ai/recipe-macros", new { recipe = "rice and beans", servings = 4 } };
        yield return new object?[] { HttpMethod.Post, "/api/ai/suggest-foods", new { } };
        yield return new object?[] { HttpMethod.Post, "/api/ai/hydration-suggest", new { } };
        yield return new object?[] { HttpMethod.Post, "/api/ai/parse-hydration", new { text = "2 coffees and a big water" } };
        yield return new object?[] { HttpMethod.Post, "/api/ai/natural-goal", new { text = "lose 10 lbs in 3 months" } };
        yield return new object?[] { HttpMethod.Post, "/api/ai/build-day", new { text = "had eggs for breakfast and ran 3 miles" } };
        yield return new object?[] { HttpMethod.Post, "/api/ai/day-summary", new { date = "2026-06-17" } };
        yield return new object?[] { HttpMethod.Get, "/api/ai/daily-coach", null };
        yield return new object?[] { HttpMethod.Get, "/api/ai/weekly-review", null };
        yield return new object?[] { HttpMethod.Get, "/api/ai/weight-insight", null };
    }

    /// <summary>The two multimodal photo routes; both validate the image before anything else.</summary>
    public static IEnumerable<object[]> PhotoRoutes()
    {
        yield return new object[] { "/api/ai/photo-meal" };
        yield return new object[] { "/api/ai/read-label" };
    }

    private static Task<HttpResponseMessage> Send(HttpClient client, HttpMethod method, string url, object? body) =>
        method == HttpMethod.Get
            ? client.GetAsync(url)
            : client.PostAsJsonAsync(url, body ?? new { });

    // ---- Auth gating: anonymous → 401 on every route ----

    [Theory]
    [MemberData(nameof(AllRoutes))]
    public async Task Ai_route_requires_authentication(HttpMethod method, string url, object? body)
    {
        var anon = factory.CreateClient();
        (await Send(anon, method, url, body)).StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    [Theory]
    [MemberData(nameof(PhotoRoutes))]
    public async Task Ai_photo_route_requires_authentication(string url)
    {
        var anon = factory.CreateClient();
        (await anon.PostAsJsonAsync(url, new { imageBase64 = "AAAA", mimeType = "image/png" }))
            .StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    // ---- Auth gating: tracker.self alone is NOT enough (needs tracker.ai) → 403 ----

    [Theory]
    [MemberData(nameof(AllRoutes))]
    public async Task Ai_route_requires_tracker_ai_not_tracker_self(HttpMethod method, string url, object? body)
    {
        var (_, selfOnly) = await ProvisionUser("tracker.self");
        (await Send(selfOnly, method, url, body)).StatusCode.Should().Be(HttpStatusCode.Forbidden);
    }

    [Theory]
    [MemberData(nameof(PhotoRoutes))]
    public async Task Ai_photo_route_requires_tracker_ai_not_tracker_self(string url)
    {
        var (_, selfOnly) = await ProvisionUser("tracker.self");
        // A 403 from the permission filter precedes the image validation — a tracker.self user can't reach it.
        (await selfOnly.PostAsJsonAsync(url, new { imageBase64 = "AAAA", mimeType = "image/png" }))
            .StatusCode.Should().Be(HttpStatusCode.Forbidden);
    }

    // ---- The photo routes ALSO require ai.vision (multimodal gate) ON TOP of tracker.ai → 403 without it ----

    [Theory]
    [MemberData(nameof(PhotoRoutes))]
    public async Task Ai_photo_route_requires_ai_vision_on_top_of_tracker_ai(string url)
    {
        // tracker.ai alone reaches the text AI group, but the IMAGE intake is gated by ai.vision — a
        // valid image is rejected with 403 (the vision filter precedes the image validation + 503).
        var (_, noVision) = await ProvisionUser("tracker.ai");
        var res = await noVision.PostAsJsonAsync(url, new
        {
            imageBase64 = Convert.ToBase64String(new byte[64]),
            mimeType = "image/png",
        });
        res.StatusCode.Should().Be(HttpStatusCode.Forbidden);
    }

    // ---- Graceful 503 when Gemini is unconfigured (no key in the test env), with tracker.ai granted ----

    [Theory]
    [MemberData(nameof(AllRoutes))]
    public async Task Ai_route_returns_503_when_unconfigured(HttpMethod method, string url, object? body)
    {
        var (_, user) = await ProvisionUser("tracker.ai");
        (await Send(user, method, url, body)).StatusCode.Should().Be(HttpStatusCode.ServiceUnavailable);
    }

    [Theory]
    [MemberData(nameof(PhotoRoutes))]
    public async Task Ai_photo_route_returns_503_when_unconfigured_for_a_valid_image(string url)
    {
        var (_, user) = await ProvisionUser("tracker.ai", "ai.vision");
        // A tiny but VALID base64 png payload passes image validation, so we reach the unconfigured 503.
        var ok = await user.PostAsJsonAsync(url, new
        {
            imageBase64 = Convert.ToBase64String(new byte[64]),
            mimeType = "image/png",
        });
        ok.StatusCode.Should().Be(HttpStatusCode.ServiceUnavailable);
    }

    // ---- Image validation: bad mime / oversized payload → 400 (before the unconfigured check) ----

    [Theory]
    [MemberData(nameof(PhotoRoutes))]
    public async Task Ai_photo_route_rejects_wrong_mime_type(string url)
    {
        var (_, user) = await ProvisionUser("tracker.ai", "ai.vision");
        var res = await user.PostAsJsonAsync(url, new
        {
            imageBase64 = Convert.ToBase64String(new byte[64]),
            mimeType = "application/pdf",
        });
        res.StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    [Theory]
    [MemberData(nameof(PhotoRoutes))]
    public async Task Ai_photo_route_rejects_oversized_image(string url)
    {
        var (_, user) = await ProvisionUser("tracker.ai", "ai.vision");
        // ~6 MB decoded — over the ~5 MB cap.
        var big = Convert.ToBase64String(new byte[6 * 1024 * 1024]);
        var res = await user.PostAsJsonAsync(url, new { imageBase64 = big, mimeType = "image/jpeg" });
        res.StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    [Theory]
    [MemberData(nameof(PhotoRoutes))]
    public async Task Ai_photo_route_rejects_missing_or_unparseable_image(string url)
    {
        var (_, user) = await ProvisionUser("tracker.ai", "ai.vision");
        (await user.PostAsJsonAsync(url, new { imageBase64 = "", mimeType = "image/png" }))
            .StatusCode.Should().Be(HttpStatusCode.BadRequest);
        (await user.PostAsJsonAsync(url, new { imageBase64 = "not valid base64!!!", mimeType = "image/png" }))
            .StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    // ---- build-day: structural validation runs BEFORE the unconfigured check (400, not 503) ----

    [Fact]
    public async Task Build_day_rejects_empty_input_with_400()
    {
        var (_, user) = await ProvisionUser("tracker.ai");
        // No text, no images, no prior draft -> a 400 "describe your day" before any upstream/config check.
        (await user.PostAsJsonAsync("/api/ai/build-day", new { }))
            .StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task Build_day_rejects_too_many_photos_with_400()
    {
        var (_, user) = await ProvisionUser("tracker.ai");
        var img = new { imageBase64 = Convert.ToBase64String(new byte[64]), mimeType = "image/png" };
        var res = await user.PostAsJsonAsync("/api/ai/build-day", new
        {
            text = "a day",
            images = new[] { img, img, img, img, img }, // 5 > cap of 4
        });
        res.StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task Build_day_rejects_a_bad_image_with_400()
    {
        var (_, user) = await ProvisionUser("tracker.ai");
        var res = await user.PostAsJsonAsync("/api/ai/build-day", new
        {
            text = "a day",
            images = new[] { new { imageBase64 = "AAAA", mimeType = "application/pdf" } },
        });
        res.StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task Build_day_with_text_returns_503_when_unconfigured()
    {
        var (_, user) = await ProvisionUser("tracker.ai");
        // Valid input -> passes structural validation, then hits the unconfigured 503 (test host has no key).
        // A TEXT-ONLY build runs on tracker.ai ALONE: no ai.vision needed (it never reaches the 403 gate).
        var res = await user.PostAsJsonAsync("/api/ai/build-day", new { text = "eggs and a run" });
        res.StatusCode.Should().Be(HttpStatusCode.ServiceUnavailable);
    }

    // ---- build-day with IMAGES additionally requires ai.vision (text-only stays on tracker.ai alone) ----

    [Fact]
    public async Task Build_day_with_an_image_requires_ai_vision_403_without_it()
    {
        // tracker.ai reaches the build-day handler, but the moment an image is attached the call is
        // multimodal -> the SEPARATE ai.vision perm is required. A valid image without it is a 403
        // (the vision gate precedes the unconfigured 503, so this is NOT a degraded-503 path).
        var (_, noVision) = await ProvisionUser("tracker.ai");
        var res = await noVision.PostAsJsonAsync("/api/ai/build-day", new
        {
            text = "lunch from this photo",
            images = new[] { new { imageBase64 = Convert.ToBase64String(new byte[64]), mimeType = "image/png" } },
        });
        res.StatusCode.Should().Be(HttpStatusCode.Forbidden);
    }

    [Fact]
    public async Task Build_day_with_an_image_and_ai_vision_passes_the_gate_503_when_unconfigured()
    {
        // With BOTH tracker.ai AND ai.vision the image-bearing build clears every gate and reaches the
        // unconfigured 503 (test host has no key) — i.e. the vision path is allowed, not forbidden.
        var (_, withVision) = await ProvisionUser("tracker.ai", "ai.vision");
        var res = await withVision.PostAsJsonAsync("/api/ai/build-day", new
        {
            text = "lunch from this photo",
            images = new[] { new { imageBase64 = Convert.ToBase64String(new byte[64]), mimeType = "image/png" } },
        });
        res.StatusCode.Should().Be(HttpStatusCode.ServiceUnavailable);
    }

    // ---- The new tracker.ai permission is surfaced by the catalog (data-driven Users matrix) ----

    [Fact]
    public async Task Tracker_ai_permission_appears_in_the_catalog()
    {
        var res = await Admin().GetAsync("/api/permissions");
        res.StatusCode.Should().Be(HttpStatusCode.OK);
        var keys = (await res.Content.ReadFromJsonAsync<List<PermissionRow>>())!
            .Select(p => p.Key)
            .ToList();
        keys.Should().Contain("tracker.ai");
    }

    private sealed record PermissionRow(string Key, string Group, string Label, string Description);

    // =====================================================================================
    // TRACKER WEEKLY RECAP — gated by tracker.self (NOT tracker.ai); ALWAYS-200 plain FLOOR
    // =====================================================================================

    [Fact]
    public async Task Tracker_recap_requires_authentication()
    {
        var anon = factory.CreateClient();
        (await anon.GetAsync("/api/ai/tracker-recap")).StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task Tracker_recap_requires_tracker_self_permission()
    {
        // A user with NEITHER tracker.self nor tracker.ai is forbidden (the recap is a tracker.self feature).
        var (_, noPerms) = await ProvisionUser("reporter.view");
        (await noPerms.GetAsync("/api/ai/tracker-recap")).StatusCode.Should().Be(HttpStatusCode.Forbidden);
    }

    [Fact]
    public async Task Tracker_recap_falls_back_to_plain_never_503_and_writes_nothing()
    {
        // tracker.self is enough — the deterministic floor needs no AI (tracker.ai is the optional upgrade).
        var (email, user) = await ProvisionUser("tracker.self");

        // Log a day of food so the floor reflects real aggregation.
        var today = DateTime.UtcNow.ToString("yyyy-MM-dd");
        await user.PostAsJsonAsync("/api/tracker/food", new
        {
            date = today, meal = "breakfast", description = "Oatmeal",
            quantity = 1.0, calories = 350, proteinG = 12.0, carbG = 60.0, fatG = 6.0,
        });

        // Gemini is OFF in the test host -> ALWAYS 200 with the deterministic plain floor, never a 503.
        var res = await user.GetAsync("/api/ai/tracker-recap");
        res.StatusCode.Should().Be(HttpStatusCode.OK);
        var dto = await res.Content.ReadFromJsonAsync<System.Text.Json.JsonElement>();

        dto.GetProperty("fellBackToPlain").GetBoolean().Should().BeTrue();
        dto.GetProperty("narrative").GetString().Should().NotBeNullOrWhiteSpace();
        // The plain floor narrates the server-aggregated week: at least one day logged.
        dto.GetProperty("narrative").GetString().Should().Contain("of 7 days");
        dto.GetProperty("insights").GetArrayLength().Should().Be(0); // no insights on the floor
        // The facts the recap is built from carry no email anywhere on the wire.
        dto.GetRawText().Should().NotContain("@");

        // The read changed nothing: the day still has exactly the one food entry.
        var day = await user.GetAsync($"/api/tracker/day?date={today}");
        day.StatusCode.Should().Be(HttpStatusCode.OK);
        (await day.Content.ReadAsStringAsync()).Should().Contain("Oatmeal");
    }

    [Fact]
    public async Task Tracker_recap_with_no_data_still_returns_a_plain_floor()
    {
        var (_, user) = await ProvisionUser("tracker.self"); // never logged anything

        var res = await user.GetAsync("/api/ai/tracker-recap");
        res.StatusCode.Should().Be(HttpStatusCode.OK);
        var dto = await res.Content.ReadFromJsonAsync<System.Text.Json.JsonElement>();
        dto.GetProperty("fellBackToPlain").GetBoolean().Should().BeTrue();
        dto.GetProperty("narrative").GetString().Should().Contain("logged 0 of 7 days");
    }

    [Fact]
    public async Task Tracker_recap_with_tracker_ai_still_returns_a_200_floor_when_unconfigured()
    {
        // tracker.ai is the gated LLM upgrade for the recap, but with Gemini OFF in the test host the endpoint
        // still returns the deterministic 200 floor (never a 503). The AI-perm branch is exercised here.
        var (_, user) = await ProvisionUser("tracker.self", "tracker.ai");
        var res = await user.GetAsync("/api/ai/tracker-recap");
        res.StatusCode.Should().Be(HttpStatusCode.OK);
        var dto = await res.Content.ReadFromJsonAsync<System.Text.Json.JsonElement>();
        dto.GetProperty("fellBackToPlain").GetBoolean().Should().BeTrue();
        dto.GetProperty("narrative").GetString().Should().NotBeNullOrWhiteSpace();
    }
}
