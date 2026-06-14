using Ccusage.Api.Services;
using FluentAssertions;

namespace Ccusage.Api.Tests.Unit;

public class DiscordNotifierTests
{
    [Theory]
    // Accepted: genuine https Discord webhooks.
    [InlineData("https://discord.com/api/webhooks/123/abc", true)]
    [InlineData("https://discordapp.com/api/webhooks/123/abc", true)]
    [InlineData("https://canary.discord.com/api/webhooks/1/2", true)]
    [InlineData("https://ptb.discord.com/api/webhooks/1/2", true)]
    // Rejected: scheme, host, path, and SSRF tricks.
    [InlineData("http://discord.com/api/webhooks/1/2", false)]          // not https
    [InlineData("https://evil.com/api/webhooks/1/2", false)]            // wrong host
    [InlineData("https://discord.com.evil.com/api/webhooks/1/2", false)] // suffix host trick
    [InlineData("https://discord.com@evil.com/api/webhooks/1", false)]   // userinfo trick (host is evil.com)
    [InlineData("https://discord.com/api/notwebhooks/1", false)]         // wrong path
    [InlineData("http://169.254.169.254/latest/meta-data", false)]       // cloud metadata SSRF
    [InlineData("https://localhost/api/webhooks/1/2", false)]            // internal host
    [InlineData("not-a-url", false)]
    [InlineData("", false)]
    [InlineData(null, false)]
    public void Validates_only_real_discord_webhooks(string? url, bool expected)
        => DiscordNotifier.IsValidWebhook(url).Should().Be(expected);
}
