using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using System.Text;
using Ccusage.Api.Data;
using Ccusage.Api.Dtos;
using Google.Apis.Auth;
using Microsoft.EntityFrameworkCore;
using Microsoft.IdentityModel.Tokens;

namespace Ccusage.Api.Services;

public enum SignInStatus { Ok, Forbidden, Invalid }

public sealed record SignInResult(SignInStatus Status, AuthResultDto? Auth, string? Email, string? Name);

/// <summary>
/// Verifies a Google ID token, looks the user up in the database (must exist + be enabled),
/// records the login, and issues an app JWT. Authorization (permissions) is NOT baked into the
/// JWT — it is re-checked against the DB on every request.
/// </summary>
public sealed class GoogleAuthService(UsageDbContext db, IConfiguration config, ILogger<GoogleAuthService> logger)
{
    public async Task<SignInResult> SignInAsync(string idToken, CancellationToken ct)
    {
        var clientId = config["Google:ClientId"];
        if (string.IsNullOrWhiteSpace(clientId))
        {
            logger.LogError("Google:ClientId is not configured (appsettings.Local.json).");
            return new SignInResult(SignInStatus.Invalid, null, null, null);
        }

        GoogleJsonWebSignature.Payload payload;
        try
        {
            payload = await GoogleJsonWebSignature.ValidateAsync(idToken, new GoogleJsonWebSignature.ValidationSettings
            {
                Audience = new[] { clientId },
            });
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Google ID token validation failed.");
            return new SignInResult(SignInStatus.Invalid, null, null, null);
        }

        if (string.IsNullOrEmpty(payload.Email) || !payload.EmailVerified)
            return new SignInResult(SignInStatus.Forbidden, null, payload.Email, payload.Name);

        var email = payload.Email.Trim().ToLowerInvariant();
        var user = await db.Users.Include(u => u.Permissions).FirstOrDefaultAsync(u => u.Email == email, ct);
        if (user is null || !user.IsEnabled)
        {
            logger.LogWarning("Sign-in denied for {Email} (not provisioned or disabled).", email);
            return new SignInResult(SignInStatus.Forbidden, null, email, payload.Name);
        }

        user.Name = payload.Name ?? user.Name;
        user.Picture = payload.Picture ?? user.Picture;
        user.LastLoginUtc = DateTime.UtcNow;
        await db.SaveChangesAsync(ct);

        var permissions = user.Permissions.Select(p => p.Permission).ToArray();
        var (jwt, expires) = IssueToken(payload.Subject, email, user.Name, user.Picture);

        return new SignInResult(SignInStatus.Ok, new AuthResultDto
        {
            Token = jwt,
            Email = email,
            Name = user.Name,
            Picture = user.Picture,
            ExpiresAtUtc = expires,
            Permissions = permissions,
        }, email, user.Name);
    }

    private (string Jwt, DateTime Expires) IssueToken(string? subject, string email, string name, string? picture)
    {
        var key = config["Jwt:Key"];
        if (string.IsNullOrWhiteSpace(key) || Encoding.UTF8.GetByteCount(key) < 32)
            throw new InvalidOperationException("Jwt:Key is missing or too short (set it in appsettings.Local.json).");

        var creds = new SigningCredentials(new SymmetricSecurityKey(Encoding.UTF8.GetBytes(key)), SecurityAlgorithms.HmacSha256);
        var expires = DateTime.UtcNow.AddMinutes(config.GetValue("Jwt:ExpiryMinutes", 1440));

        var claims = new List<Claim>
        {
            new(JwtRegisteredClaimNames.Sub, subject ?? email),
            new("email", email),
            new("name", name),
        };
        if (!string.IsNullOrEmpty(picture)) claims.Add(new Claim("picture", picture));

        var token = new JwtSecurityToken(
            issuer: config["Jwt:Issuer"],
            audience: config["Jwt:Audience"],
            claims: claims,
            expires: expires,
            signingCredentials: creds);

        return (new JwtSecurityTokenHandler().WriteToken(token), expires);
    }
}
