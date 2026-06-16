using Ccusage.Api.Data.Entities;
using Microsoft.EntityFrameworkCore;

namespace Ccusage.Api.Data;

public class UsageDbContext(DbContextOptions<UsageDbContext> options) : DbContext(options)
{
    public DbSet<UsageRecord> UsageRecords => Set<UsageRecord>();
    public DbSet<Project> Projects => Set<Project>();
    public DbSet<ModelPricing> ModelPricings => Set<ModelPricing>();
    public DbSet<IngestedFile> IngestedFiles => Set<IngestedFile>();
    public DbSet<AppConfig> AppConfigs => Set<AppConfig>();
    public DbSet<IngestionSource> IngestionSources => Set<IngestionSource>();
    public DbSet<SyncStatus> SyncStatuses => Set<SyncStatus>();
    public DbSet<AppUser> Users => Set<AppUser>();
    public DbSet<UserPermission> UserPermissions => Set<UserPermission>();
    public DbSet<AuditEntry> AuditEntries => Set<AuditEntry>();
    public DbSet<RequestLog> RequestLogs => Set<RequestLog>();
    public DbSet<NotificationSetting> NotificationSettings => Set<NotificationSetting>();
    public DbSet<ShareLink> ShareLinks => Set<ShareLink>();
    public DbSet<ShareAccess> ShareAccesses => Set<ShareAccess>();
    public DbSet<IngestKey> IngestKeys => Set<IngestKey>();

    protected override void OnModelCreating(ModelBuilder b)
    {
        b.Entity<UsageRecord>(e =>
        {
            e.Property(x => x.TimestampUtc).HasColumnType("timestamp with time zone");
            e.Property(x => x.CostUsd).HasPrecision(18, 8);
            e.Property(x => x.Source).HasMaxLength(32).HasDefaultValue("claude-code");
            e.Property(x => x.MessageId).HasMaxLength(128);
            e.Property(x => x.RequestId).HasMaxLength(128);
            e.Property(x => x.DedupKey).HasMaxLength(300);
            e.Property(x => x.Model).HasMaxLength(128);
            e.Property(x => x.SessionId).HasMaxLength(128);
            e.Property(x => x.AgentId).HasMaxLength(128);
            e.Property(x => x.GitBranch).HasMaxLength(256);
            e.Property(x => x.Version).HasMaxLength(64);
            e.Property(x => x.MachineName).HasMaxLength(200).HasDefaultValue("");
            e.Property(x => x.ReportedByUser).HasMaxLength(256).HasDefaultValue("");

            e.HasIndex(x => x.DedupKey).IsUnique();
            e.HasIndex(x => x.LocalDate);
            e.HasIndex(x => new { x.ProjectId, x.LocalDate });
            e.HasIndex(x => x.Model);
            e.HasIndex(x => x.SessionId);
            e.HasIndex(x => x.IsSidechain);
            e.HasIndex(x => x.Source);
            e.HasIndex(x => x.MachineName);
            e.HasIndex(x => x.ReportedByUser);

            e.HasOne(x => x.Project).WithMany(p => p.Records)
                .HasForeignKey(x => x.ProjectId).OnDelete(DeleteBehavior.Cascade);
            e.HasOne(x => x.IngestedFile).WithMany()
                .HasForeignKey(x => x.IngestedFileId).OnDelete(DeleteBehavior.Cascade);
        });

        b.Entity<Project>(e =>
        {
            e.Property(x => x.Name).HasMaxLength(256);
            e.Property(x => x.RepoRoot).HasMaxLength(1024);
            e.Property(x => x.FolderName).HasMaxLength(512);
            e.HasIndex(x => x.RepoRoot).IsUnique();
        });

        b.Entity<ModelPricing>(e =>
        {
            e.Property(x => x.ModelPattern).HasMaxLength(128);
            e.Property(x => x.DisplayName).HasMaxLength(128);
            e.Property(x => x.InputPerMTok).HasPrecision(12, 4);
            e.Property(x => x.OutputPerMTok).HasPrecision(12, 4);
            e.Property(x => x.CacheWrite5mPerMTok).HasPrecision(12, 4);
            e.Property(x => x.CacheWrite1hPerMTok).HasPrecision(12, 4);
            e.Property(x => x.CacheReadPerMTok).HasPrecision(12, 4);
            e.HasIndex(x => x.ModelPattern).IsUnique();
            e.HasData(PricingSeed.Rows);
        });

        b.Entity<IngestedFile>(e =>
        {
            e.Property(x => x.Path).HasMaxLength(1024);
            e.Property(x => x.LastModifiedUtc).HasColumnType("timestamp with time zone");
            e.Property(x => x.LastSyncUtc).HasColumnType("timestamp with time zone");
            e.HasIndex(x => x.Path).IsUnique();
        });

        b.Entity<AppConfig>(e =>
        {
            e.Property(x => x.DisplayTimeZone).HasMaxLength(64);
            e.Property(x => x.ClaudeProjectsPath).HasMaxLength(1024);
            e.Property(x => x.AutoSyncEnabled).HasDefaultValue(true);
            e.Property(x => x.AutoSyncIntervalSeconds).HasDefaultValue(300);
            e.Property(x => x.OpenSignupEnabled).HasDefaultValue(true);
            e.Property(x => x.DefaultPermissionsCsv).HasMaxLength(1024).HasDefaultValue("dashboard.view");
        });

        b.Entity<IngestionSource>(e =>
        {
            e.Property(x => x.Name).HasMaxLength(32);
            e.Property(x => x.Kind).HasMaxLength(32);
            e.Property(x => x.RootPath).HasMaxLength(1024);
            e.HasIndex(x => x.Name).IsUnique();
        });

        b.Entity<SyncStatus>(e =>
        {
            e.Property(x => x.LastSyncUtc).HasColumnType("timestamp with time zone");
            e.HasData(new SyncStatus { Id = 1 });
        });

        b.Entity<AppUser>(e =>
        {
            e.Property(x => x.Email).HasMaxLength(256);
            e.Property(x => x.GoogleSubject).HasMaxLength(64);
            e.Property(x => x.Name).HasMaxLength(256);
            e.Property(x => x.Picture).HasMaxLength(1024);
            e.Property(x => x.CreatedUtc).HasColumnType("timestamp with time zone");
            e.Property(x => x.LastLoginUtc).HasColumnType("timestamp with time zone");
            e.HasIndex(x => x.Email).IsUnique();
            // One Google account maps to at most one user row (nulls allowed for not-yet-logged-in users).
            e.HasIndex(x => x.GoogleSubject).IsUnique().HasFilter("\"GoogleSubject\" IS NOT NULL");
            e.HasMany(x => x.Permissions).WithOne(p => p.User!)
                .HasForeignKey(p => p.UserId).OnDelete(DeleteBehavior.Cascade);
        });

        b.Entity<UserPermission>(e =>
        {
            e.Property(x => x.Permission).HasMaxLength(64);
            e.HasIndex(x => new { x.UserId, x.Permission }).IsUnique();
        });

        b.Entity<AuditEntry>(e =>
        {
            e.Property(x => x.WhenUtc).HasColumnType("timestamp with time zone");
            e.Property(x => x.ActorEmail).HasMaxLength(256);
            e.Property(x => x.Action).HasMaxLength(64);
            e.Property(x => x.TargetEmail).HasMaxLength(256);
            e.Property(x => x.Detail).HasMaxLength(1024);
            e.HasIndex(x => x.WhenUtc);
        });

        b.Entity<RequestLog>(e =>
        {
            e.Property(x => x.WhenUtc).HasColumnType("timestamp with time zone");
            e.Property(x => x.Method).HasMaxLength(16);
            e.Property(x => x.Path).HasMaxLength(2048);
            e.Property(x => x.QueryString).HasMaxLength(4096);
            e.Property(x => x.UserEmail).HasMaxLength(256);
            e.Property(x => x.ClientIp).HasMaxLength(64);
            // Bodies are already truncated by the middleware; store as unbounded text.
            e.HasIndex(x => x.Id).IsDescending(); // newest-first reads
        });

        b.Entity<NotificationSetting>(e =>
        {
            e.Property(x => x.DiscordWebhookUrl).HasMaxLength(512);
            e.Property(x => x.MentionOnAlert).HasMaxLength(64);
            e.Property(x => x.ThresholdUsd).HasPrecision(18, 2);
            e.HasData(new NotificationSetting { Id = 1 });
        });

        b.Entity<ShareLink>(e =>
        {
            e.Property(x => x.TokenHash).HasMaxLength(64);
            e.Property(x => x.TokenEnc).HasMaxLength(256);
            e.Property(x => x.Label).HasMaxLength(120);
            e.Property(x => x.CreatedByEmail).HasMaxLength(256);
            e.Property(x => x.GroupBy).HasMaxLength(16);
            e.Property(x => x.CreatedUtc).HasColumnType("timestamp with time zone");
            e.Property(x => x.ExpiresUtc).HasColumnType("timestamp with time zone");
            e.Property(x => x.LastAccessedUtc).HasColumnType("timestamp with time zone");
            e.HasIndex(x => x.TokenHash).IsUnique();
        });

        b.Entity<ShareAccess>(e =>
        {
            e.Property(x => x.WhenUtc).HasColumnType("timestamp with time zone");
            e.Property(x => x.Ip).HasMaxLength(64);
            e.HasIndex(x => new { x.ShareLinkId, x.WhenUtc });
            e.HasOne(x => x.ShareLink).WithMany()
                .HasForeignKey(x => x.ShareLinkId).OnDelete(DeleteBehavior.Cascade);
        });

        b.Entity<IngestKey>(e =>
        {
            e.Property(x => x.Name).HasMaxLength(64);
            e.Property(x => x.KeyHash).HasMaxLength(64);
            e.Property(x => x.Prefix).HasMaxLength(24);
            e.Property(x => x.CreatedByEmail).HasMaxLength(256);
            e.Property(x => x.LastUsedIp).HasMaxLength(64);
            e.Property(x => x.CreatedUtc).HasColumnType("timestamp with time zone");
            e.Property(x => x.LastUsedUtc).HasColumnType("timestamp with time zone");
            e.Property(x => x.RevokedUtc).HasColumnType("timestamp with time zone");
            e.HasIndex(x => x.KeyHash).IsUnique();
            e.HasIndex(x => x.UserId);
            // A deleted user must not cascade-delete usage-bearing keys: orphan them instead.
            e.HasOne(x => x.User).WithMany()
                .HasForeignKey(x => x.UserId).OnDelete(DeleteBehavior.SetNull);
        });
    }
}
