using Ccusage.Api.Services;
using FluentAssertions;

namespace Ccusage.Api.Tests.Unit;

public class DiscordWebhookValidatorTests
{
    [Theory]
    // Accepted.
    [InlineData("https://discord.com/api/webhooks/123/abc", true)]
    [InlineData("https://discordapp.com/api/webhooks/123/abc", true)]
    [InlineData("https://canary.discord.com/api/webhooks/1/2", true)]
    [InlineData("https://ptb.discord.com/api/webhooks/1/2", true)]
    // Rejected: scheme / host / path / SSRF tricks (shared allowlist with DiscordNotifier).
    [InlineData("http://discord.com/api/webhooks/1/2", false)]
    [InlineData("https://evil.com/api/webhooks/1/2", false)]
    [InlineData("https://discord.com.evil.com/api/webhooks/1/2", false)]
    [InlineData("https://discord.com@evil.com/api/webhooks/1", false)]
    [InlineData("https://discord.com/api/notwebhooks/1", false)]
    [InlineData("http://169.254.169.254/latest/meta-data", false)]   // cloud metadata SSRF
    [InlineData("http://127.0.0.1/api/webhooks/1/2", false)]          // loopback
    [InlineData("https://localhost/api/webhooks/1/2", false)]         // internal host
    [InlineData("http://10.0.0.5/api/webhooks/1/2", false)]           // private IP
    [InlineData("not-a-url", false)]
    [InlineData("", false)]
    [InlineData(null, false)]
    public void IsValid_only_real_discord_webhooks(string? url, bool expected)
        => DiscordWebhookValidator.IsValid(url).Should().Be(expected);

    [Fact]
    public void Hint_masks_id_and_token_and_never_contains_the_full_token()
    {
        const string token = "supersecrettoken1234";
        var url = $"https://discord.com/api/webhooks/123456789012345678/{token}";

        var hint = DiscordWebhookValidator.Hint(url);

        hint.Should().NotBeNull();
        hint!.Should().NotContain(token);             // never the full token
        hint.Should().EndWith("1234");                // last 4 only
        hint.Should().Contain("12345678");            // id prefix
        hint.Should().StartWith("discord.com/api/webhooks/");
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("https://evil.com/api/webhooks/1/2")]
    public void Hint_is_null_for_invalid_or_missing(string? url)
        => DiscordWebhookValidator.Hint(url).Should().BeNull();
}
