using Ccusage.Api.Infrastructure;
using FluentAssertions;

namespace Ccusage.Api.Tests.Unit;

public class LogRedactionTests
{
    [Fact]
    public void Null_or_empty_passes_through()
    {
        LogRedaction.Redact(null, "/api/usage").Should().BeNull();
        LogRedaction.Redact("", "/api/usage").Should().Be("");
    }

    [Theory]
    [InlineData("/api/auth/google")]
    [InlineData("/api/auth/refresh")]
    [InlineData("/api/notifications")]
    public void Sensitive_routes_are_fully_redacted(string path)
        => LogRedaction.Redact("{\"idToken\":\"super-secret\",\"discordWebhookUrl\":\"https://discord.com/x\"}", path)
            .Should().Be("[redacted]");

    [Fact]
    public void Secret_fields_are_redacted_on_other_routes()
    {
        var r = LogRedaction.Redact("{\"name\":\"alice\",\"password\":\"hunter2\",\"token\":\"abc123\"}", "/api/users")!;
        r.Should().Contain("\"name\":\"alice\"");
        r.Should().Contain("\"password\":\"[redacted]\"");
        r.Should().Contain("\"token\":\"[redacted]\"");
        r.Should().NotContain("hunter2");
        r.Should().NotContain("abc123");
    }

    [Fact]
    public void Secret_field_matching_is_case_insensitive()
    {
        var r = LogRedaction.Redact("{\"Password\":\"p@ss\",\"ApiKey\":\"k-1\"}", "/api/x")!;
        r.Should().NotContain("p@ss");
        r.Should().NotContain("k-1");
    }

    [Fact]
    public void Clean_body_passes_through_unchanged()
    {
        const string body = "{\"email\":\"a@b.com\",\"isEnabled\":true}";
        LogRedaction.Redact(body, "/api/users").Should().Be(body);
    }

    [Fact]
    public void Long_bodies_are_truncated()
    {
        var big = new string('x', LogRedaction.MaxBodyChars + 500);
        var r = LogRedaction.Redact(big, "/api/usage")!;
        r.Length.Should().BeLessThan(big.Length);
        r.Should().EndWith("[truncated]");
    }

    [Fact]
    public void Urlencoded_form_body_secrets_are_redacted()
    {
        var r = LogRedaction.Redact("name=alice&password=hunter2&access_token=ya29xyz", "/api/something")!;
        r.Should().NotContain("hunter2");
        r.Should().NotContain("ya29xyz");
        r.Should().Contain("password=[redacted]");
        r.Should().Contain("access_token=[redacted]");
        r.Should().Contain("name=alice");
    }

    [Fact]
    public void Query_string_secrets_are_redacted()
    {
        var r = LogRedaction.RedactQuery("?groupBy=day&access_token=ya29.SECRET&id=5", "/api/usage/summary")!;
        r.Should().NotContain("ya29.SECRET");
        r.Should().Contain("access_token=[redacted]");
        r.Should().Contain("groupBy=day");
        r.Should().Contain("id=5");
    }

    [Fact]
    public void Query_string_on_an_auth_route_is_fully_redacted()
        => LogRedaction.RedactQuery("?code=abc", "/api/auth/google").Should().Be("[redacted]");

    [Fact]
    public void Clean_query_string_passes_through()
        => LogRedaction.RedactQuery("?groupBy=day&from=2026-01-01", "/api/usage/summary")
            .Should().Be("?groupBy=day&from=2026-01-01");
}
