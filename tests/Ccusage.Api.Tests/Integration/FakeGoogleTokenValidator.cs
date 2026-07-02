using Ccusage.Api.Services;
using Google.Apis.Auth;

namespace Ccusage.Api.Tests.Integration;

/// <summary>
/// Stands in for Google's token validation in tests. The "idToken" directly encodes the identity
/// as "email|subject" (subject optional), so a test can drive first-login binding and the
/// subject-mismatch rejection without contacting Google. An idToken of "invalid" simulates a
/// token that fails validation. Prefixing the token with "unverified|" (e.g. "unverified|email|sub")
/// yields a validated-but-unverified-email payload, so a test can exercise the
/// GoogleAuthService <c>!payload.EmailVerified</c> account-takeover guard.
/// </summary>
public sealed class FakeGoogleTokenValidator : IGoogleTokenValidator
{
    public Task<GoogleJsonWebSignature.Payload> ValidateAsync(string idToken, string clientId, CancellationToken ct)
    {
        if (idToken == "invalid")
            throw new InvalidOperationException("Simulated invalid Google token.");

        // "unverified|email|sub" -> a token Google validated, but whose email is NOT verified.
        var emailVerified = true;
        if (idToken.StartsWith("unverified|", StringComparison.Ordinal))
        {
            emailVerified = false;
            idToken = idToken["unverified|".Length..];
        }

        var parts = idToken.Split('|');
        return Task.FromResult(new GoogleJsonWebSignature.Payload
        {
            Email = parts[0],
            EmailVerified = emailVerified,
            Subject = parts.Length > 1 ? parts[1] : "sub-default",
            Name = "Test User",
        });
    }
}
