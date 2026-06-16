using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using System.Text;
using Ccusage.Api.Data;
using Ccusage.Api.Data.Entities;
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
public sealed class GoogleAuthService(
    UsageDbContext db, IGoogleTokenValidator validator, IConfiguration config,
    ILogger<GoogleAuthService> logger, IHttpContextAccessor http)
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
            payload = await validator.ValidateAsync(idToken, clientId, ct);
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Google ID token validation failed.");
            return new SignInResult(SignInStatus.Invalid, null, null, null);
        }

        // A validated token must carry a verified email and a stable Google subject id.
        if (string.IsNullOrEmpty(payload.Email) || !payload.EmailVerified || string.IsNullOrEmpty(payload.Subject))
            return new SignInResult(SignInStatus.Forbidden, null, payload.Email, payload.Name);

        var email = payload.Email.Trim().ToLowerInvariant();
        var user = await db.Users.Include(u => u.Permissions).FirstOrDefaultAsync(u => u.Email == email, ct);

        if (user is null)
        {
            // No account yet. If open sign-up is off, deny (as before). Otherwise auto-provision the
            // account with the configured default permissions and bind it to this Google id now.
            // We do NOT audit a "not provisioned" denial: that path is reachable by ANY Google account,
            // so auditing it would let an outside party flood the log (and any forwarded security alert).
            var cfg = await db.AppConfigs.FirstOrDefaultAsync(ct);
            if (cfg is null || !cfg.OpenSignupEnabled)
            {
                logger.LogWarning("Sign-in denied for {Email} (not provisioned; open sign-up disabled).", email);
                return new SignInResult(SignInStatus.Forbidden, null, email, payload.Name);
            }

            var defaultPerms = ParseDefaultPermissions(cfg.DefaultPermissionsCsv);
            var created = new AppUser
            {
                Email = email,
                Name = payload.Name ?? "",
                Picture = payload.Picture,
                IsEnabled = true,
                CreatedUtc = DateTime.UtcNow,
                GoogleSubject = payload.Subject, // bind on create
                LastLoginUtc = DateTime.UtcNow,
                Permissions = defaultPerms.Select(p => new UserPermission { Permission = p }).ToList(),
            };
            db.Users.Add(created);
            db.AuditEntries.Add(new AuditEntry
            {
                WhenUtc = DateTime.UtcNow,
                ActorEmail = email,
                Action = "user.autoprovisioned",
                TargetEmail = email,
                Detail = $"permissions=[{string.Join(", ", defaultPerms)}]",
            });

            try
            {
                await db.SaveChangesAsync(ct);
            }
            catch (DbUpdateException)
            {
                // Lost a race: a concurrent first sign-in for the same account (e.g. One Tap and the
                // rendered button firing together, or a double-submit) already created the row. The
                // unique Email/GoogleSubject indexes correctly rejected our duplicate — so discard this
                // attempt, reload the committed row, and fall through to the normal existing-user path.
                db.ChangeTracker.Clear();
                user = await db.Users.Include(u => u.Permissions).FirstOrDefaultAsync(u => u.Email == email, ct);
                if (user is null) throw; // not a recoverable uniqueness race
            }

            if (user is null)
            {
                // Create succeeded (no race): issue a token for the brand-new account.
                logger.LogInformation("Auto-provisioned {Email} with [{Permissions}] on first sign-in.",
                    email, string.Join(", ", defaultPerms));

                await RecordLoginAsync(email, created.Id, success: true, "auto-provisioned", payload.Name, ct);

                var (newJwt, newExpires) = IssueToken(payload.Subject, email, created.Name, created.Picture);
                return new SignInResult(SignInStatus.Ok, new AuthResultDto
                {
                    Token = newJwt,
                    Email = email,
                    Name = created.Name,
                    Picture = created.Picture,
                    ExpiresAtUtc = newExpires,
                    Permissions = defaultPerms,
                }, email, created.Name);
            }
            // else: race recovered — `user` now holds the row the winning request created; continue below.
        }

        if (!user.IsEnabled)
        {
            logger.LogWarning("Sign-in denied for {Email} (disabled).", email);
            await AuditDenialAsync(email, "account disabled", ct);
            await RecordLoginAsync(email, user.Id, success: false, "account disabled", payload.Name, ct);
            return new SignInResult(SignInStatus.Forbidden, null, email, payload.Name);
        }

        // Pin the account to its Google id: bind on first login, reject if a later login presents
        // the same email under a different Google account (e.g. a recycled/reassigned address).
        if (string.IsNullOrEmpty(user.GoogleSubject))
        {
            user.GoogleSubject = payload.Subject;
            logger.LogInformation("Bound {Email} to Google subject {Subject} on first sign-in.", email, payload.Subject);
        }
        else if (!string.Equals(user.GoogleSubject, payload.Subject, StringComparison.Ordinal))
        {
            logger.LogWarning(
                "Sign-in denied for {Email}: Google subject mismatch (account is bound to a different Google id).", email);
            await AuditDenialAsync(email, "Google id mismatch", ct);
            await RecordLoginAsync(email, user.Id, success: false, "google id mismatch", payload.Name, ct);
            return new SignInResult(SignInStatus.Forbidden, null, email, payload.Name);
        }

        user.Name = payload.Name ?? user.Name;
        user.Picture = payload.Picture ?? user.Picture;
        user.LastLoginUtc = DateTime.UtcNow;
        await db.SaveChangesAsync(ct);

        await RecordLoginAsync(email, user.Id, success: true, "ok", payload.Name, ct);

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

    /// <summary>
    /// Parse a default-permissions CSV into distinct, defaultable keys (order preserved). Filters to
    /// <see cref="Auth.Permissions.IsDefaultable"/> so a stray <c>users.manage</c> in the stored policy
    /// can never auto-grant admin to a freshly provisioned account.
    /// </summary>
    private static string[] ParseDefaultPermissions(string? csv) =>
        (csv ?? "").Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Where(Auth.Permissions.IsDefaultable).Distinct().ToArray();

    /// <summary>
    /// Record a structured per-user login event (history shown on the Users page). BEST-EFFORT: a
    /// failure here is logged and swallowed so it can never block or fail an otherwise-valid sign-in.
    /// Captures the server-observed client IP (post-UseForwardedHeaders) and the request User-Agent.
    /// </summary>
    private async Task RecordLoginAsync(string email, int? userId, bool success, string reason, string? name, CancellationToken ct)
    {
        try
        {
            var ctx = http.HttpContext;
            var ip = ctx?.Connection.RemoteIpAddress?.ToString() ?? "";
            var userAgent = ctx?.Request.Headers.UserAgent.ToString();
            if (userAgent is { Length: > 256 }) userAgent = userAgent[..256];

            db.LoginEvents.Add(new LoginEvent
            {
                Email = email,
                UserId = userId,
                WhenUtc = DateTime.UtcNow,
                Ip = ip,
                Success = success,
                Reason = reason,
                Name = name,
                UserAgent = string.IsNullOrEmpty(userAgent) ? null : userAgent,
            });
            await db.SaveChangesAsync(ct);
        }
        catch (Exception ex)
        {
            // Never let login-history bookkeeping break a sign-in.
            logger.LogWarning(ex, "Failed to record login event for {Email} (reason={Reason}).", email, reason);
        }
    }

    /// <summary>Record a denied sign-in in the audit log (a security signal; also forwarded to Discord if enabled).</summary>
    private async Task AuditDenialAsync(string email, string reason, CancellationToken ct)
    {
        db.AuditEntries.Add(new AuditEntry
        {
            WhenUtc = DateTime.UtcNow,
            ActorEmail = email,
            Action = "auth.denied",
            TargetEmail = email,
            Detail = reason,
        });
        await db.SaveChangesAsync(ct);
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
