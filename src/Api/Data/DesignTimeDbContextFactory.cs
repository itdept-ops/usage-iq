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
        var conn = Environment.GetEnvironmentVariable("ConnectionStrings__Default")
                   ?? "Host=localhost;Port=5433;Database=ccusage;Username=ccusage;Password=ccusage_dev_pw";
        var options = new DbContextOptionsBuilder<UsageDbContext>().UseNpgsql(conn).Options;
        return new UsageDbContext(options);
    }
}
