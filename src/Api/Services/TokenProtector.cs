using System.Security.Cryptography;
using System.Text;

namespace Ccusage.Api.Services;

/// <summary>
/// Symmetric encryption for secrets at rest (share tokens, OAuth refresh tokens, webhook URLs, ...).
/// Keyed off a stable app secret so ciphertext survives restarts — unlike ASP.NET Data Protection keys,
/// which aren't persisted in the container. A DB leak alone can't reveal the plaintext without the secret.
///
/// SECURITY — key management:
///  * The at-rest key is derived from a DEDICATED secret (<c>Encryption:Key</c>) so it is decoupled from
///    the JWT signing key. This means <c>Jwt:Key</c> can be rotated for JWT hygiene without bricking every
///    encrypted refresh token / webhook / share token stored in the DB.
///  * For backward compatibility, if <c>Encryption:Key</c> is not configured we fall back to <c>Jwt:Key</c>
///    (the historical behavior) so existing ciphertext keeps decrypting. Once an <c>Encryption:Key</c> is
///    provisioned, it MUST NEVER be rotated without a decrypt-old / re-encrypt-new migration, or every
///    previously stored ciphertext becomes permanently undecryptable.
/// </summary>
public sealed class TokenProtector
{
    private readonly byte[] _key;

    public TokenProtector(IConfiguration config)
    {
        // Prefer a dedicated, separately-rotatable data-encryption secret; fall back to Jwt:Key so existing
        // ciphertext (encrypted before this secret existed) still decrypts and the app still boots without it.
        var k = config["Encryption:Key"]
                ?? config["Jwt:Key"]
                ?? throw new InvalidOperationException("Encryption:Key or Jwt:Key is required.");
        // Domain-separated 256-bit key derived from the app secret.
        _key = SHA256.HashData(Encoding.UTF8.GetBytes("usage-iq:share-token:" + k));
    }

    /// <summary>
    /// AES-GCM encrypt → base64(nonce(12) | tag(16) | ciphertext).
    /// <paramref name="purpose"/> is bound in as GCM associated data so a ciphertext produced for one
    /// context (e.g. "google-refresh") fails authentication if presented in another (e.g. "bill-share"),
    /// preventing cross-context transplantation of high-value ciphertext into a low-privilege column.
    /// Call sites SHOULD pass a stable per-purpose tag; the empty default preserves the historical,
    /// context-less format so ciphertext written before this parameter existed still decrypts.
    /// </summary>
    public string Protect(string plaintext, string? purpose = null)
    {
        var nonce = RandomNumberGenerator.GetBytes(12);
        var pt = Encoding.UTF8.GetBytes(plaintext);
        var ct = new byte[pt.Length];
        var tag = new byte[16];
        var aad = AssociatedData(purpose);

        using var aes = new AesGcm(_key, 16);
        aes.Encrypt(nonce, pt, ct, tag, aad);

        var blob = new byte[nonce.Length + tag.Length + ct.Length];
        Buffer.BlockCopy(nonce, 0, blob, 0, 12);
        Buffer.BlockCopy(tag, 0, blob, 12, 16);
        Buffer.BlockCopy(ct, 0, blob, 28, ct.Length);
        return Convert.ToBase64String(blob);
    }

    /// <summary>
    /// Reverse of <see cref="Protect"/>; returns null if missing or tampered/undecryptable.
    /// <paramref name="purpose"/> must match the value used when the ciphertext was produced.
    /// </summary>
    public string? Unprotect(string? blob64, string? purpose = null)
    {
        if (string.IsNullOrEmpty(blob64)) return null;
        try
        {
            var blob = Convert.FromBase64String(blob64);
            if (blob.Length < 28) return null;
            var nonce = blob.AsSpan(0, 12);
            var tag = blob.AsSpan(12, 16);
            var ct = blob.AsSpan(28);
            var pt = new byte[ct.Length];
            var aad = AssociatedData(purpose);

            using var aes = new AesGcm(_key, 16);
            aes.Decrypt(nonce, ct, tag, pt, aad);
            return Encoding.UTF8.GetString(pt);
        }
        catch
        {
            return null;
        }
    }

    /// <summary>
    /// Maps an optional purpose to GCM associated data. A null/empty purpose yields <c>null</c> AAD,
    /// which is byte-for-byte compatible with ciphertext produced before per-purpose binding existed.
    /// </summary>
    private static byte[]? AssociatedData(string? purpose)
        => string.IsNullOrEmpty(purpose)
            ? null
            : Encoding.UTF8.GetBytes("usage-iq:purpose:" + purpose);
}
