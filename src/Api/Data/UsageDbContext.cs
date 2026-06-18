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
    public DbSet<LoginEvent> LoginEvents => Set<LoginEvent>();
    public DbSet<RequestLog> RequestLogs => Set<RequestLog>();
    public DbSet<NotificationSetting> NotificationSettings => Set<NotificationSetting>();
    public DbSet<ShareLink> ShareLinks => Set<ShareLink>();
    public DbSet<ShareAccess> ShareAccesses => Set<ShareAccess>();
    public DbSet<IngestKey> IngestKeys => Set<IngestKey>();
    public DbSet<SavedView> SavedViews => Set<SavedView>();
    public DbSet<MachineInfo> MachineInfos => Set<MachineInfo>();
    public DbSet<ChatChannel> ChatChannels => Set<ChatChannel>();
    public DbSet<ChatChannelMember> ChatChannelMembers => Set<ChatChannelMember>();
    public DbSet<ChatMessage> ChatMessages => Set<ChatMessage>();
    public DbSet<ChatMessageReaction> ChatMessageReactions => Set<ChatMessageReaction>();
    public DbSet<ChatContact> ChatContacts => Set<ChatContact>();
    public DbSet<Notification> Notifications => Set<Notification>();
    public DbSet<NotificationPreference> NotificationPreferences => Set<NotificationPreference>();
    public DbSet<TrackerProfile> TrackerProfiles => Set<TrackerProfile>();
    public DbSet<FoodEntry> FoodEntries => Set<FoodEntry>();
    public DbSet<ExerciseEntry> ExerciseEntries => Set<ExerciseEntry>();
    public DbSet<ExerciseLibrary> ExerciseLibrary => Set<ExerciseLibrary>();
    public DbSet<WeightEntry> WeightEntries => Set<WeightEntry>();
    public DbSet<CustomFood> CustomFoods => Set<CustomFood>();
    public DbSet<CustomExercise> CustomExercises => Set<CustomExercise>();
    public DbSet<HydrationEntry> HydrationEntries => Set<HydrationEntry>();

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

        b.Entity<LoginEvent>(e =>
        {
            e.Property(x => x.Email).HasMaxLength(256);
            e.Property(x => x.WhenUtc).HasColumnType("timestamp with time zone");
            e.Property(x => x.Ip).HasMaxLength(64).HasDefaultValue("");
            e.Property(x => x.Reason).HasMaxLength(64);
            e.Property(x => x.Name).HasMaxLength(256);
            e.Property(x => x.UserAgent).HasMaxLength(256);
            // The per-user history filters by Email and reads newest-first; a composite index with
            // (Email asc, WhenUtc desc) serves that exact query directly, and its Email prefix also
            // covers plain lookups by email, so a separate single-column Email index is redundant.
            e.HasIndex(x => new { x.Email, x.WhenUtc }).IsDescending(false, true);
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

        b.Entity<MachineInfo>(e =>
        {
            e.Property(x => x.Name).HasMaxLength(200).HasDefaultValue("");
            e.Property(x => x.LocalIp).HasMaxLength(64);
            e.Property(x => x.PublicIp).HasMaxLength(64);
            e.Property(x => x.Os).HasMaxLength(256);
            e.Property(x => x.Arch).HasMaxLength(32);
            e.Property(x => x.Hostname).HasMaxLength(200);
            e.Property(x => x.OsUser).HasMaxLength(256);
            e.Property(x => x.Agent).HasMaxLength(32);
            e.Property(x => x.ReporterVersion).HasMaxLength(64);
            e.Property(x => x.FirstSeenUtc).HasColumnType("timestamp with time zone");
            e.Property(x => x.LastSeenUtc).HasColumnType("timestamp with time zone");
            // One metadata row per machine name; the upsert keys on this unique index.
            e.HasIndex(x => x.Name).IsUnique();
        });

        b.Entity<SavedView>(e =>
        {
            e.Property(x => x.Name).HasMaxLength(80);
            e.Property(x => x.ProjectIdsCsv).HasMaxLength(2048).HasDefaultValue("");
            e.Property(x => x.ModelsCsv).HasMaxLength(2048).HasDefaultValue("");
            e.Property(x => x.SourcesCsv).HasMaxLength(512).HasDefaultValue("");
            e.Property(x => x.IncludeSidechain).HasDefaultValue(true);
            e.Property(x => x.GroupBy).HasMaxLength(20).HasDefaultValue("day");
            e.Property(x => x.CreatedUtc).HasColumnType("timestamp with time zone");
            e.Property(x => x.LastUsedUtc).HasColumnType("timestamp with time zone");
            e.HasIndex(x => new { x.UserId, x.Name });
            // Personal views: required owner, cascade-delete with the user.
            e.HasOne(x => x.User).WithMany()
                .HasForeignKey(x => x.UserId).IsRequired().OnDelete(DeleteBehavior.Cascade);
        });

        b.Entity<ChatChannel>(e =>
        {
            e.Property(x => x.Name).HasMaxLength(120);
            // Two lower-cased emails (<=256 each) joined with a pipe.
            e.Property(x => x.DirectKey).HasMaxLength(513);
            e.Property(x => x.Topic).HasMaxLength(512);
            e.Property(x => x.CreatedByEmail).HasMaxLength(256);
            e.Property(x => x.CreatedUtc).HasColumnType("timestamp with time zone");
            e.Property(x => x.ArchivedUtc).HasColumnType("timestamp with time zone");
            // One Direct channel per unordered email pair; named channels (null key) are exempt.
            e.HasIndex(x => x.DirectKey).IsUnique().HasFilter("\"DirectKey\" IS NOT NULL");
        });

        b.Entity<ChatChannelMember>(e =>
        {
            e.Property(x => x.UserEmail).HasMaxLength(256);
            e.Property(x => x.JoinedUtc).HasColumnType("timestamp with time zone");
            e.Property(x => x.MutedUntil).HasColumnType("timestamp with time zone");
            // One membership row per (channel, user); also the lookup for "is the caller a member".
            e.HasIndex(x => new { x.ChannelId, x.UserEmail }).IsUnique();
            e.HasOne(x => x.Channel).WithMany(c => c.Members)
                .HasForeignKey(x => x.ChannelId).OnDelete(DeleteBehavior.Cascade);
        });

        b.Entity<ChatMessage>(e =>
        {
            e.Property(x => x.SenderEmail).HasMaxLength(256);
            e.Property(x => x.Body).HasMaxLength(4000);
            e.Property(x => x.CreatedUtc).HasColumnType("timestamp with time zone");
            e.Property(x => x.EditedUtc).HasColumnType("timestamp with time zone");
            e.Property(x => x.DeletedUtc).HasColumnType("timestamp with time zone");
            // Channel timelines page newest-first within a channel.
            e.HasIndex(x => new { x.ChannelId, x.CreatedUtc });
            e.HasOne(x => x.Channel).WithMany(c => c.Messages)
                .HasForeignKey(x => x.ChannelId).OnDelete(DeleteBehavior.Cascade);
        });

        b.Entity<ChatMessageReaction>(e =>
        {
            e.Property(x => x.UserEmail).HasMaxLength(256);
            e.Property(x => x.Emoji).HasMaxLength(32);
            e.Property(x => x.CreatedUtc).HasColumnType("timestamp with time zone");
            // One of each emoji per user per message; also the lookup for "does this reaction exist".
            e.HasIndex(x => new { x.MessageId, x.UserEmail, x.Emoji }).IsUnique();
            // Batch-load all reactions for a page of messages by message id.
            e.HasIndex(x => x.MessageId);
            e.HasOne(x => x.Message).WithMany()
                .HasForeignKey(x => x.MessageId).OnDelete(DeleteBehavior.Cascade);
        });

        b.Entity<ChatContact>(e =>
        {
            e.Property(x => x.OwnerEmail).HasMaxLength(256);
            e.Property(x => x.ContactEmail).HasMaxLength(256);
            e.Property(x => x.AddedByEmail).HasMaxLength(256);
            e.Property(x => x.CreatedUtc).HasColumnType("timestamp with time zone");
            // One directed edge per (owner, contact); also the lookup for "is X in Y's circle".
            e.HasIndex(x => new { x.OwnerEmail, x.ContactEmail }).IsUnique();
        });

        b.Entity<Notification>(e =>
        {
            e.Property(x => x.RecipientEmail).HasMaxLength(256);
            e.Property(x => x.Text).HasMaxLength(512);
            e.Property(x => x.Link).HasMaxLength(512);
            e.Property(x => x.ActorEmail).HasMaxLength(256);
            e.Property(x => x.ActorName).HasMaxLength(256);
            e.Property(x => x.CreatedUtc).HasColumnType("timestamp with time zone");
            // The inbox reads a recipient's unread/all notifications newest-first.
            e.HasIndex(x => new { x.RecipientEmail, x.IsRead, x.CreatedUtc });
        });

        b.Entity<NotificationPreference>(e =>
        {
            e.Property(x => x.UserEmail).HasMaxLength(256);
            e.Property(x => x.NotifyDirectMessages).HasDefaultValue(true);
            e.Property(x => x.NotifyMentions).HasDefaultValue(true);
            e.Property(x => x.NotifyChannelMessages).HasDefaultValue(false);
            e.Property(x => x.NotifySystemEvents).HasDefaultValue(true);
            e.Property(x => x.SurfaceToasts).HasDefaultValue(true);
            e.Property(x => x.SurfaceBrowser).HasDefaultValue(false);
            e.Property(x => x.UpdatedUtc).HasColumnType("timestamp with time zone");
            e.HasIndex(x => x.UserEmail).IsUnique();
        });

        b.Entity<TrackerProfile>(e =>
        {
            e.Property(x => x.UserEmail).HasMaxLength(256);
            e.Property(x => x.UpdatedUtc).HasColumnType("timestamp with time zone");
            // One profile row per user; also the lookup for "this caller's profile".
            e.HasIndex(x => x.UserEmail).IsUnique();
        });

        b.Entity<FoodEntry>(e =>
        {
            e.Property(x => x.UserEmail).HasMaxLength(256);
            e.Property(x => x.Description).HasMaxLength(256);
            e.Property(x => x.Brand).HasMaxLength(256);
            e.Property(x => x.ServingDesc).HasMaxLength(128);
            e.Property(x => x.CreatedUtc).HasColumnType("timestamp with time zone");
            // The day view reads one user's entries for one local date.
            e.HasIndex(x => new { x.UserEmail, x.LocalDate });
        });

        b.Entity<ExerciseEntry>(e =>
        {
            e.Property(x => x.UserEmail).HasMaxLength(256);
            e.Property(x => x.Name).HasMaxLength(128);
            e.Property(x => x.CreatedUtc).HasColumnType("timestamp with time zone");
            // The day view reads one user's entries for one local date.
            e.HasIndex(x => new { x.UserEmail, x.LocalDate });
            // Deleting a library activity must not delete a logged workout: orphan the FK instead
            // (the activity name is snapshotted onto the row, so the log stays readable).
            e.HasOne(x => x.Exercise).WithMany()
                .HasForeignKey(x => x.ExerciseId).OnDelete(DeleteBehavior.SetNull);
        });

        b.Entity<ExerciseLibrary>(e =>
        {
            e.Property(x => x.Name).HasMaxLength(128);
            e.Property(x => x.Category).HasMaxLength(64);
            e.Property(x => x.GoalTags).HasMaxLength(128);
        });

        b.Entity<WeightEntry>(e =>
        {
            e.Property(x => x.UserEmail).HasMaxLength(256);
            e.Property(x => x.CreatedUtc).HasColumnType("timestamp with time zone");
            // One reading per user per local date (logging again that day upserts); also the trend read.
            e.HasIndex(x => new { x.UserEmail, x.LocalDate }).IsUnique();
        });

        b.Entity<HydrationEntry>(e =>
        {
            e.Property(x => x.UserEmail).HasMaxLength(256);
            e.Property(x => x.Label).HasMaxLength(64);
            e.Property(x => x.CreatedUtc).HasColumnType("timestamp with time zone");
            // The day view reads one user's drinks for one local date (no unique — many drinks per day).
            e.HasIndex(x => new { x.UserEmail, x.LocalDate });
        });

        b.Entity<CustomFood>(e =>
        {
            e.Property(x => x.UserEmail).HasMaxLength(256);
            e.Property(x => x.Description).HasMaxLength(256);
            // Brand + ServingDesc are normalized to "" (never null) so the dedup key below is stable.
            e.Property(x => x.Brand).HasMaxLength(256).HasDefaultValue("");
            e.Property(x => x.ServingDesc).HasMaxLength(128).HasDefaultValue("");
            e.Property(x => x.CreatedUtc).HasColumnType("timestamp with time zone");
            e.Property(x => x.LastUsedUtc).HasColumnType("timestamp with time zone");
            // The "My foods" list reads one user's saved foods newest-used-first.
            e.HasIndex(x => new { x.UserEmail, x.LastUsedUtc });
            // One saved row per (user, food identity); the manual-log upsert keys on this unique index.
            e.HasIndex(x => new { x.UserEmail, x.Description, x.Brand, x.ServingDesc }).IsUnique();
        });

        b.Entity<CustomExercise>(e =>
        {
            e.Property(x => x.UserEmail).HasMaxLength(256);
            e.Property(x => x.Name).HasMaxLength(128);
            // NameKey is the trim+lower'd Name used for dedup; stored alongside the display Name.
            e.Property(x => x.NameKey).HasMaxLength(128);
            e.Property(x => x.CreatedUtc).HasColumnType("timestamp with time zone");
            e.Property(x => x.LastUsedUtc).HasColumnType("timestamp with time zone");
            // The "My exercises" list reads one user's saved exercises newest-used-first.
            e.HasIndex(x => new { x.UserEmail, x.LastUsedUtc });
            // One saved row per (user, normalized name); the manual-log upsert keys on this unique index.
            e.HasIndex(x => new { x.UserEmail, x.NameKey }).IsUnique();
        });
    }
}
