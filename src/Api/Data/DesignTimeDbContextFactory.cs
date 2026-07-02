using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Design;

namespace Ccusage.Api.Data;

/// <summary>
/// Lets <c>dotnet ef</c> create the context for migrations without booting the web app
/// (which would try to connect and run startup migration/seed logic).
/// </summary>
public sealed class DesignTimeDbContextFactory : IDesignTimeDbContextFactory<UsageDbContext>
{
    public UsageDbContext CreateDbContext(string[] args)
    {
        // Prefer a full connection string, then a password-only override, else a clearly
        // non-secret placeholder so `dotnet ef` can build the model without a live DB or a
        // committed real-looking secret.
        var conn = Environment.GetEnvironmentVariable("ConnectionStrings__Default");
        if (string.IsNullOrWhiteSpace(conn))
        {
            var password = Environment.GetEnvironmentVariable("POSTGRES_PASSWORD");
            if (string.IsNullOrWhiteSpace(password))
                password = "postgres";
            conn = $"Host=localhost;Port=5433;Database=ccusage;Username=ccusage;Password={password}";
        }
        var options = new DbContextOptionsBuilder<UsageDbContext>().UseNpgsql(conn).Options;
        return new UsageDbContext(options);
    }
}
