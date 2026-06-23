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
    public DbSet<AiUsageLog> AiUsageLogs => Set<AiUsageLog>();
    public DbSet<NotificationSetting> NotificationSettings => Set<NotificationSetting>();
    public DbSet<DiscordRoute> DiscordRoutes => Set<DiscordRoute>();
    public DbSet<ShareLink> ShareLinks => Set<ShareLink>();
    public DbSet<ShareAccess> ShareAccesses => Set<ShareAccess>();
    public DbSet<IngestKey> IngestKeys => Set<IngestKey>();
    public DbSet<SavedView> SavedViews => Set<SavedView>();
    public DbSet<MachineInfo> MachineInfos => Set<MachineInfo>();
    public DbSet<UserLocation> UserLocations => Set<UserLocation>();
    public DbSet<ChatChannel> ChatChannels => Set<ChatChannel>();
    public DbSet<ChatChannelMember> ChatChannelMembers => Set<ChatChannelMember>();
    public DbSet<ChatMessage> ChatMessages => Set<ChatMessage>();
    public DbSet<ChatMessageReaction> ChatMessageReactions => Set<ChatMessageReaction>();
    public DbSet<ChatContact> ChatContacts => Set<ChatContact>();
    public DbSet<ChatLocationShare> ChatLocationShares => Set<ChatLocationShare>();
    public DbSet<Notification> Notifications => Set<Notification>();
    public DbSet<NotificationPreference> NotificationPreferences => Set<NotificationPreference>();
    public DbSet<NudgeEvent> NudgeEvents => Set<NudgeEvent>();
    public DbSet<TrackerProfile> TrackerProfiles => Set<TrackerProfile>();
    public DbSet<FoodEntry> FoodEntries => Set<FoodEntry>();
    public DbSet<ExerciseEntry> ExerciseEntries => Set<ExerciseEntry>();
    public DbSet<ExerciseLibrary> ExerciseLibrary => Set<ExerciseLibrary>();
    public DbSet<WeightEntry> WeightEntries => Set<WeightEntry>();
    public DbSet<CustomFood> CustomFoods => Set<CustomFood>();
    public DbSet<CustomExercise> CustomExercises => Set<CustomExercise>();
    public DbSet<HydrationEntry> HydrationEntries => Set<HydrationEntry>();
    public DbSet<CoffeeEntry> CoffeeEntries => Set<CoffeeEntry>();
    public DbSet<SupplementEntry> SupplementEntries => Set<SupplementEntry>();
    public DbSet<SleepEntry> SleepEntries => Set<SleepEntry>();
    public DbSet<DailyActivity> DailyActivities => Set<DailyActivity>();
    public DbSet<Household> Households => Set<Household>();
    public DbSet<HouseholdMember> HouseholdMembers => Set<HouseholdMember>();
    public DbSet<FamilyNote> FamilyNotes => Set<FamilyNote>();
    public DbSet<FamilyList> FamilyLists => Set<FamilyList>();
    public DbSet<FamilyListItem> FamilyListItems => Set<FamilyListItem>();
    public DbSet<FamilyShare> FamilyShares => Set<FamilyShare>();
    public DbSet<FamilyReminder> FamilyReminders => Set<FamilyReminder>();
    public DbSet<FamilyTimer> FamilyTimers => Set<FamilyTimer>();
    public DbSet<FamilyMeal> FamilyMeals => Set<FamilyMeal>();
    public DbSet<FamilyChore> FamilyChores => Set<FamilyChore>();
    public DbSet<FamilyChoreCompletion> FamilyChoreCompletions => Set<FamilyChoreCompletion>();
    public DbSet<FamilyCreditEntry> FamilyCreditEntries => Set<FamilyCreditEntry>();
    public DbSet<FinanceAccount> FinanceAccounts => Set<FinanceAccount>();
    public DbSet<FinanceTransaction> FinanceTransactions => Set<FinanceTransaction>();
    public DbSet<FinanceImport> FinanceImports => Set<FinanceImport>();
    public DbSet<GoogleCalendarConnection> GoogleCalendarConnections => Set<GoogleCalendarConnection>();
    public DbSet<FamilyPlanPoll> FamilyPlanPolls => Set<FamilyPlanPoll>();
    public DbSet<FamilyPlanPollOption> FamilyPlanPollOptions => Set<FamilyPlanPollOption>();
    public DbSet<FamilyPlanPollVote> FamilyPlanPollVotes => Set<FamilyPlanPollVote>();
    public DbSet<FamilyEventAnnouncement> FamilyEventAnnouncements => Set<FamilyEventAnnouncement>();
    public DbSet<CycleProfile> CycleProfiles => Set<CycleProfile>();
    public DbSet<CyclePeriod> CyclePeriods => Set<CyclePeriod>();
    public DbSet<CycleDayLog> CycleDayLogs => Set<CycleDayLog>();
    public DbSet<IdentityRole> IdentityRoles => Set<IdentityRole>();
    public DbSet<IdentityTimeEntry> IdentityTimeEntries => Set<IdentityTimeEntry>();
    public DbSet<IdentityRule> IdentityRules => Set<IdentityRule>();
    public DbSet<Bill> Bills => Set<Bill>();
    public DbSet<BillItem> BillItems => Set<BillItem>();
    public DbSet<HardChallenge> HardChallenges => Set<HardChallenge>();
    public DbSet<HardChallengeDay> HardChallengeDays => Set<HardChallengeDay>();
    public DbSet<HardChallengeTask> HardChallengeTasks => Set<HardChallengeTask>();
    public DbSet<HardChallengeDayTask> HardChallengeDayTasks => Set<HardChallengeDayTask>();
    public DbSet<ActivityEvent> ActivityEvents => Set<ActivityEvent>();
    public DbSet<ActivityReaction> ActivityReactions => Set<ActivityReaction>();
    public DbSet<AutomationRule> AutomationRules => Set<AutomationRule>();

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
            e.Property(x => x.HomeRoute).HasMaxLength(64);
            e.Property(x => x.CreatedUtc).HasColumnType("timestamp with time zone");
            e.Property(x => x.LastLoginUtc).HasColumnType("timestamp with time zone");
            // Location opt-in + sharing are OFF by default (privacy: capture is opt-in, sharing separate).
            e.Property(x => x.LocationEnabled).HasDefaultValue(false);
            e.Property(x => x.LocationShareHousehold).HasDefaultValue(false);
            // Calendar event-sharing to the household is OFF by default (privacy: opt-in, like location).
            e.Property(x => x.CalendarShareHousehold).HasDefaultValue(false);
            // Display-name preference (how the user appears to OTHERS): default FirstInitial ("First L.").
            e.Property(x => x.DisplayNameMode).HasDefaultValue(DisplayNameMode.FirstInitial);
            e.Property(x => x.Nickname).HasMaxLength(64);
            e.Property(x => x.PresenceStatus).HasMaxLength(120);
            // Appear-offline + auto-context sharing are OFF by default (visible-by-default presence, no auto-context).
            e.Property(x => x.AppearOffline).HasDefaultValue(false);
            e.Property(x => x.ShareAutoContext).HasDefaultValue(false);
            // Activity-feed share + view opt-ins are OFF by default (privacy: opt-in to share AND to view).
            e.Property(x => x.ShareActivity).HasDefaultValue(false);
            e.Property(x => x.ViewActivityFeed).HasDefaultValue(false);
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

        b.Entity<AiUsageLog>(e =>
        {
            e.Property(x => x.WhenUtc).HasColumnType("timestamp with time zone");
            e.Property(x => x.UserEmail).HasMaxLength(256);
            e.Property(x => x.Feature).HasMaxLength(64);
            e.Property(x => x.Model).HasMaxLength(64);
            e.Property(x => x.Outcome).HasMaxLength(16);
            e.Property(x => x.ErrorHint).HasMaxLength(200);
            e.HasIndex(x => x.WhenUtc).IsDescending();          // newest-first window reads
            e.HasIndex(x => new { x.UserEmail, x.WhenUtc });    // per-user lookups
        });

        b.Entity<NotificationSetting>(e =>
        {
            e.Property(x => x.DiscordWebhookUrl).HasMaxLength(512);
            e.Property(x => x.MentionOnAlert).HasMaxLength(64);
            e.Property(x => x.ThresholdUsd).HasPrecision(18, 2);
            e.HasData(new NotificationSetting { Id = 1 });
        });

        b.Entity<DiscordRoute>(e =>
        {
            e.Property(x => x.EventKey).HasMaxLength(64);
            e.Property(x => x.Label).HasMaxLength(120);
            e.Property(x => x.Mention).HasMaxLength(64);
            // One row per routable event; also the lookup the senders use.
            e.HasIndex(x => x.EventKey).IsUnique();
            // Seed the routable events DISABLED; the migration that adds this then copies the existing
            // NotificationSetting flags into Enabled so live config is preserved (digest/threshold/security).
            e.HasData(
                new DiscordRoute { Id = 1, EventKey = DiscordRouteKeys.DailyDigest, Label = "Daily digest", SortOrder = 1 },
                new DiscordRoute { Id = 2, EventKey = DiscordRouteKeys.WeeklyDigest, Label = "Weekly digest", SortOrder = 2 },
                new DiscordRoute { Id = 3, EventKey = DiscordRouteKeys.SpendThreshold, Label = "Spend threshold alert", SortOrder = 3 },
                new DiscordRoute { Id = 4, EventKey = DiscordRouteKeys.SecurityAlerts, Label = "Security alerts", SortOrder = 4 },
                new DiscordRoute { Id = 5, EventKey = DiscordRouteKeys.NewUserSignup, Label = "New user signup", SortOrder = 5 });
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

        b.Entity<Bill>(e =>
        {
            e.Property(x => x.OwnerEmail).HasMaxLength(256);
            e.Property(x => x.Title).HasMaxLength(200);
            e.Property(x => x.ShareTokenHash).HasMaxLength(64);
            e.Property(x => x.ShareTokenEnc).HasMaxLength(256);
            e.Property(x => x.Status).HasMaxLength(16);
            e.Property(x => x.TaxAmount).HasColumnType("numeric(12,2)");
            e.Property(x => x.TipAmount).HasColumnType("numeric(12,2)");
            e.Property(x => x.CreatedUtc).HasColumnType("timestamp with time zone");
            e.HasIndex(x => x.OwnerEmail);
            // Unique only over the live (non-null) hashes — mirrors the GoogleSubject filtered-unique pattern
            // so many bills can have a null hash (no share) yet a live token is the single public lookup key.
            e.HasIndex(x => x.ShareTokenHash).IsUnique().HasFilter("\"ShareTokenHash\" IS NOT NULL");
        });

        b.Entity<BillItem>(e =>
        {
            e.Property(x => x.Name).HasMaxLength(200);
            e.Property(x => x.Amount).HasColumnType("numeric(12,2)");
            e.Property(x => x.ClaimedByName).HasMaxLength(80);
            e.Property(x => x.ClaimedUtc).HasColumnType("timestamp with time zone");
            e.HasIndex(x => x.BillId);
            e.HasOne(x => x.Bill).WithMany(x => x.Items)
                .HasForeignKey(x => x.BillId).OnDelete(DeleteBehavior.Cascade);
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
            // IP-geo of PublicIp (coarse): city/region/country + lat/lng, resolved best-effort & cached.
            e.Property(x => x.City).HasMaxLength(120);
            e.Property(x => x.Region).HasMaxLength(120);
            e.Property(x => x.Country).HasMaxLength(120);
            e.Property(x => x.GeoUpdatedUtc).HasColumnType("timestamp with time zone");
            // One metadata row per machine name; the upsert keys on this unique index.
            e.HasIndex(x => x.Name).IsUnique();
        });

        b.Entity<UserLocation>(e =>
        {
            e.Property(x => x.UserEmail).HasMaxLength(256);
            e.Property(x => x.Source).HasMaxLength(16).HasDefaultValue("manual");
            e.Property(x => x.City).HasMaxLength(120);
            e.Property(x => x.Region).HasMaxLength(120);
            e.Property(x => x.Country).HasMaxLength(120);
            e.Property(x => x.CapturedUtc).HasColumnType("timestamp with time zone");
            // The own-history read filters by UserEmail and pages newest-first; this composite serves it
            // directly, and its UserEmail prefix also covers the admin "latest per user" scan.
            e.HasIndex(x => new { x.UserEmail, x.CapturedUtc }).IsDescending(false, true);
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

        b.Entity<ActivityReaction>(e =>
        {
            e.Property(x => x.ReactorEmail).HasMaxLength(256);
            e.Property(x => x.CreatedUtc).HasColumnType("timestamp with time zone");
            // One cheer per user per event; also the lookup for "has this user cheered this event".
            e.HasIndex(x => new { x.ReactorEmail, x.ActivityEventId }).IsUnique();
            // Batch-load all reactions for a page of feed events by event id.
            e.HasIndex(x => x.ActivityEventId);
            e.HasOne<ActivityEvent>().WithMany()
                .HasForeignKey(x => x.ActivityEventId).OnDelete(DeleteBehavior.Cascade);
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

        b.Entity<ChatLocationShare>(e =>
        {
            e.Property(x => x.SharerEmail).HasMaxLength(256);
            e.Property(x => x.StartUtc).HasColumnType("timestamp with time zone");
            e.Property(x => x.ExpiresUtc).HasColumnType("timestamp with time zone");
            e.Property(x => x.LastUpdateUtc).HasColumnType("timestamp with time zone");
            // The active-shares-per-conversation read filters by ChannelId and expiry; this composite serves it.
            e.HasIndex(x => new { x.ChannelId, x.ExpiresUtc });
            e.HasOne(x => x.Channel).WithMany()
                .HasForeignKey(x => x.ChannelId).OnDelete(DeleteBehavior.Cascade);
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

        b.Entity<NudgeEvent>(e =>
        {
            e.Property(x => x.SenderEmail).HasMaxLength(256);
            e.Property(x => x.TargetEmail).HasMaxLength(256);
            e.Property(x => x.CreatedUtc).HasColumnType("timestamp with time zone");
            // The cooldown check reads the latest row for a (sender, target) pair within a recent window.
            e.HasIndex(x => new { x.SenderEmail, x.TargetEmail, x.CreatedUtc });
        });

        b.Entity<AutomationRule>(e =>
        {
            e.Property(x => x.OwnerEmail).HasMaxLength(256);
            e.Property(x => x.Name).HasMaxLength(80);
            e.Property(x => x.TriggerKind).HasMaxLength(64);
            e.Property(x => x.MessageTemplate).HasMaxLength(200);
            e.Property(x => x.Enabled).HasDefaultValue(true);
            e.Property(x => x.CreatedUtc).HasColumnType("timestamp with time zone");
            e.Property(x => x.UpdatedUtc).HasColumnType("timestamp with time zone");
            // The evaluator's hot read: an owner's enabled rules for one trigger kind.
            e.HasIndex(x => new { x.OwnerEmail, x.TriggerKind });
            // The CRUD list: an owner's own rules.
            e.HasIndex(x => x.OwnerEmail);
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
            e.Property(x => x.SurfaceDiscord).HasDefaultValue(false);
            e.Property(x => x.WeeklyRecapEnabled).HasDefaultValue(false);
            // LastRecapSent is a nullable local DATE (the idempotency anchor) — no default; null = never sent.
            // The encrypted webhook is a base64 AES-GCM blob (nonce|tag|ciphertext) — generous cap (matches
            // GoogleCalendarConnection.EncryptedRefreshToken). The plaintext URL is NEVER persisted.
            e.Property(x => x.DiscordWebhookEnc).HasMaxLength(2048);
            e.Property(x => x.DiscordWebhookHint).HasMaxLength(120);
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
            // One reading per user per local date per slot (logging again that day+slot upserts), so a
            // user can weigh in at several slots on one day; the (UserEmail, LocalDate) prefix also serves
            // the trend read.
            e.HasIndex(x => new { x.UserEmail, x.LocalDate, x.Slot }).IsUnique();
        });

        b.Entity<HydrationEntry>(e =>
        {
            e.Property(x => x.UserEmail).HasMaxLength(256);
            e.Property(x => x.Label).HasMaxLength(64);
            e.Property(x => x.CreatedUtc).HasColumnType("timestamp with time zone");
            // The day view reads one user's drinks for one local date (no unique — many drinks per day).
            e.HasIndex(x => new { x.UserEmail, x.LocalDate });
        });

        b.Entity<CoffeeEntry>(e =>
        {
            e.Property(x => x.UserEmail).HasMaxLength(256);
            e.Property(x => x.Label).HasMaxLength(64);
            e.Property(x => x.CreatedUtc).HasColumnType("timestamp with time zone");
            // The day view reads one user's coffees for one local date (no unique — many coffees per day).
            e.HasIndex(x => new { x.UserEmail, x.LocalDate });
        });

        b.Entity<SupplementEntry>(e =>
        {
            e.Property(x => x.UserEmail).HasMaxLength(256);
            e.Property(x => x.Name).HasMaxLength(120);
            e.Property(x => x.Dose).HasMaxLength(60);
            e.Property(x => x.Kind).HasConversion<int>();
            e.Property(x => x.CreatedUtc).HasColumnType("timestamp with time zone");
            // The day view reads one user's supplements for one local date (no unique — many per day).
            e.HasIndex(x => new { x.UserEmail, x.LocalDate });
        });

        b.Entity<SleepEntry>(e =>
        {
            e.Property(x => x.UserEmail).HasMaxLength(256);
            e.Property(x => x.Note).HasMaxLength(200);
            e.Property(x => x.CreatedUtc).HasColumnType("timestamp with time zone");
            // The day view reads one user's sleep for one local date; the same prefix serves the rolling
            // 7-day average window read (no unique — naps / split sleep allowed).
            e.HasIndex(x => new { x.UserEmail, x.LocalDate });
        });

        b.Entity<DailyActivity>(e =>
        {
            e.Property(x => x.UserEmail).HasMaxLength(256);
            e.Property(x => x.CreatedUtc).HasColumnType("timestamp with time zone");
            e.Property(x => x.UpdatedUtc).HasColumnType("timestamp with time zone");
            // One watch-stats row per user per local date (recording again that day upserts); also the
            // day-view read.
            e.HasIndex(x => new { x.UserEmail, x.LocalDate }).IsUnique();
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

        b.Entity<Household>(e =>
        {
            e.Property(x => x.Name).HasMaxLength(120);
            e.Property(x => x.CreatedUtc).HasColumnType("timestamp with time zone");
            // F3 settings: defaults match the entity so an existing row migrates with sane values.
            e.Property(x => x.TimeZone).HasMaxLength(64).HasDefaultValue("America/New_York");
            e.Property(x => x.BriefingEnabled).HasDefaultValue(true);
            e.Property(x => x.BriefingHourLocal).HasDefaultValue(7);
            e.Property(x => x.WeatherLocation).HasMaxLength(120);
            // F6b settings: calendar event heads-ups (defaults match the entity so an existing row migrates).
            e.Property(x => x.EventHeadsUpEnabled).HasDefaultValue(false);
            e.Property(x => x.EventHeadsUpLeadMinutes).HasDefaultValue(15);
            e.HasMany(x => x.Members).WithOne(m => m.Household!)
                .HasForeignKey(m => m.HouseholdId).OnDelete(DeleteBehavior.Cascade);
        });

        b.Entity<HouseholdMember>(e =>
        {
            e.Property(x => x.Role).HasMaxLength(16);
            e.Property(x => x.JoinedUtc).HasColumnType("timestamp with time zone");
            // A user appears at most once in a given household.
            e.HasIndex(x => new { x.HouseholdId, x.UserId }).IsUnique();
            // One household per user for now — a user can't be a member of two households at once.
            e.HasIndex(x => x.UserId).IsUnique();
        });

        b.Entity<FamilyNote>(e =>
        {
            e.Property(x => x.Title).HasMaxLength(200);
            e.Property(x => x.CreatedUtc).HasColumnType("timestamp with time zone");
            e.Property(x => x.UpdatedUtc).HasColumnType("timestamp with time zone");
            // The family's note list reads one household's notes.
            e.HasIndex(x => x.HouseholdId);
        });

        b.Entity<FamilyList>(e =>
        {
            e.Property(x => x.Name).HasMaxLength(200);
            e.Property(x => x.Kind).HasMaxLength(16);
            e.Property(x => x.CreatedUtc).HasColumnType("timestamp with time zone");
            e.Property(x => x.UpdatedUtc).HasColumnType("timestamp with time zone");
            e.HasMany(x => x.Items).WithOne(i => i.List!)
                .HasForeignKey(i => i.ListId).OnDelete(DeleteBehavior.Cascade);
            e.HasIndex(x => x.HouseholdId);
        });

        b.Entity<FamilyListItem>(e =>
        {
            e.Property(x => x.Text).HasMaxLength(500);
            e.Property(x => x.CreatedUtc).HasColumnType("timestamp with time zone");
            e.HasIndex(x => x.ListId);
        });

        b.Entity<FamilyShare>(e =>
        {
            e.Property(x => x.ItemType).HasMaxLength(16);
            e.Property(x => x.CreatedUtc).HasColumnType("timestamp with time zone");
            // A person is shared a given item at most once; also the lookup key for "shared-with-me".
            e.HasIndex(x => new { x.ItemType, x.ItemId, x.SharedWithUserId }).IsUnique();
            // Resolving "items shared with this caller" scans by the target user.
            e.HasIndex(x => x.SharedWithUserId);
        });

        b.Entity<FamilyReminder>(e =>
        {
            e.Property(x => x.Text).HasMaxLength(500);
            e.Property(x => x.Recurrence).HasMaxLength(16);
            e.Property(x => x.DueUtc).HasColumnType("timestamp with time zone");
            e.Property(x => x.LastFiredUtc).HasColumnType("timestamp with time zone");
            e.Property(x => x.CreatedUtc).HasColumnType("timestamp with time zone");
            // The family's reminder list reads one household's reminders.
            e.HasIndex(x => x.HouseholdId);
            // The tick scans the soonest still-active, past-due reminders across all households.
            e.HasIndex(x => new { x.Active, x.DueUtc });
        });

        b.Entity<FamilyTimer>(e =>
        {
            e.Property(x => x.Label).HasMaxLength(120);
            e.Property(x => x.EndsUtc).HasColumnType("timestamp with time zone");
            e.Property(x => x.CreatedUtc).HasColumnType("timestamp with time zone");
            // The family's timer list reads one household's recent timers.
            e.HasIndex(x => x.HouseholdId);
            // The tick scans not-yet-done, past-end timers across all households.
            e.HasIndex(x => new { x.Done, x.EndsUtc });
        });

        b.Entity<FamilyMeal>(e =>
        {
            e.Property(x => x.Slot).HasMaxLength(16).HasDefaultValue("dinner");
            e.Property(x => x.Title).HasMaxLength(200);
            e.Property(x => x.Ingredients).HasMaxLength(4000).HasDefaultValue("");
            e.Property(x => x.CreatedUtc).HasColumnType("timestamp with time zone");
            // Macros (Slice 2): dish TOTALS + servings; per-serving is derived, never stored.
            e.Property(x => x.Servings).HasDefaultValue(1);
            e.Property(x => x.Calories).HasDefaultValue(0);
            e.Property(x => x.ProteinG).HasDefaultValue(0d);
            e.Property(x => x.CarbG).HasDefaultValue(0d);
            e.Property(x => x.FatG).HasDefaultValue(0d);
            e.Property(x => x.MacroSource).HasMaxLength(16).HasDefaultValue("none");
            // The weekly plan reads one household's meals over a date window.
            e.HasIndex(x => new { x.HouseholdId, x.LocalDate });
        });

        b.Entity<FamilyChore>(e =>
        {
            e.Property(x => x.Title).HasMaxLength(200);
            e.Property(x => x.Points).HasDefaultValue(1);
            e.Property(x => x.Recurrence).HasMaxLength(16).HasDefaultValue("none");
            e.Property(x => x.DoneUtc).HasColumnType("timestamp with time zone");
            e.Property(x => x.CreatedUtc).HasColumnType("timestamp with time zone");
            // Marketplace + allowance: existing rows backfill via these defaults (Status="open",
            // Source="assigned", CreditValue=0) so live data migrates cleanly.
            e.Property(x => x.CreditValue).HasPrecision(10, 2).HasDefaultValue(0m);
            e.Property(x => x.Source).HasMaxLength(16).HasDefaultValue("assigned");
            e.Property(x => x.Status).HasMaxLength(16).HasDefaultValue("open");
            e.Property(x => x.ClaimedUtc).HasColumnType("timestamp with time zone");
            e.Property(x => x.ApprovedUtc).HasColumnType("timestamp with time zone");
            // The family's chore board reads one household's chores.
            e.HasIndex(x => x.HouseholdId);
            // The tick scans recurring, currently-done chores across all households for a period reset.
            e.HasIndex(x => new { x.Done, x.Recurrence });
            // The board/queue filters one household's chores by lifecycle status.
            e.HasIndex(x => new { x.HouseholdId, x.Status });
            // A child's "my claimed chores" view reads by claimant.
            e.HasIndex(x => x.ClaimedByUserId);
        });

        b.Entity<FamilyChoreCompletion>(e =>
        {
            e.Property(x => x.AtUtc).HasColumnType("timestamp with time zone");
            e.Property(x => x.Credits).HasPrecision(10, 2).HasDefaultValue(0m);
            // The points tally sums completions per (chore's household via the chore) — load by chore.
            e.HasIndex(x => x.ChoreId);
            // The per-member tally aggregates a member's completions.
            e.HasIndex(x => x.ByUserId);
            // A completion belongs to a chore; cascade-deletes with it (the chore owns its ledger).
            e.HasOne(x => x.Chore).WithMany()
                .HasForeignKey(x => x.ChoreId).OnDelete(DeleteBehavior.Cascade);
        });

        b.Entity<FamilyCreditEntry>(e =>
        {
            e.Property(x => x.Kind).HasMaxLength(16).HasDefaultValue("earn");
            e.Property(x => x.Amount).HasPrecision(10, 2);
            e.Property(x => x.Category).HasMaxLength(32);
            e.Property(x => x.Note).HasMaxLength(256);
            e.Property(x => x.CreatedUtc).HasColumnType("timestamp with time zone");
            // The allowance read sums/lists one child's rows within a household.
            e.HasIndex(x => new { x.HouseholdId, x.ChildUserId });
            // Look up the earn row linked to a completion.
            e.HasIndex(x => x.ChoreCompletionId);
            // An earn row links to its completion; ON DELETE SET NULL preserves the money-history when a
            // chore (and thus its completions) is deleted — the balance already reflects the past earn.
            e.HasOne<FamilyChoreCompletion>().WithMany()
                .HasForeignKey(x => x.ChoreCompletionId).OnDelete(DeleteBehavior.SetNull);
        });

        b.Entity<FinanceAccount>(e =>
        {
            e.Property(x => x.Name).HasMaxLength(200);
            e.Property(x => x.Institution).HasMaxLength(200);
            e.Property(x => x.Owner).HasMaxLength(16).HasDefaultValue("unassigned");
            e.Property(x => x.Kind).HasMaxLength(16).HasDefaultValue("other");
            e.Property(x => x.CreatedUtc).HasColumnType("timestamp with time zone");
            // The accounts list reads one household's accounts.
            e.HasIndex(x => x.HouseholdId);
            // One account per distinct (household, name, institution); the find-or-create import keys on this.
            // Institution can be null, so the unique constraint treats nulls per Postgres semantics — the
            // importer normalizes a missing institution to "" to keep the key stable.
            e.HasIndex(x => new { x.HouseholdId, x.Name, x.Institution }).IsUnique();
        });

        b.Entity<FinanceTransaction>(e =>
        {
            e.Property(x => x.Merchant).HasMaxLength(300);
            e.Property(x => x.Description).HasMaxLength(500);
            e.Property(x => x.Magnitude).HasPrecision(18, 2);
            e.Property(x => x.RawAmount).HasPrecision(18, 2);
            e.Property(x => x.Kind).HasMaxLength(16).HasDefaultValue("expense");
            e.Property(x => x.Category).HasMaxLength(120);
            e.Property(x => x.Note).HasMaxLength(1000);
            e.Property(x => x.DedupHash).HasMaxLength(64);
            e.Property(x => x.CreatedUtc).HasColumnType("timestamp with time zone");
            // The transactions/summary reads filter one household by date (month window) then account/etc.
            e.HasIndex(x => new { x.HouseholdId, x.Date });
            e.HasIndex(x => x.AccountId);
            // Re-importing the same export is a no-op: a duplicate (household, dedupHash) is skipped.
            e.HasIndex(x => new { x.HouseholdId, x.DedupHash }).IsUnique();
            // Deleting an account deletes its transactions (the account owns its ledger).
            e.HasOne(x => x.Account).WithMany()
                .HasForeignKey(x => x.AccountId).OnDelete(DeleteBehavior.Cascade);
        });

        b.Entity<FinanceImport>(e =>
        {
            e.Property(x => x.FileName).HasMaxLength(260);
            e.Property(x => x.CreatedUtc).HasColumnType("timestamp with time zone");
            // The imports list reads one household's recent batches newest-first.
            e.HasIndex(x => new { x.HouseholdId, x.CreatedUtc });
        });

        b.Entity<GoogleCalendarConnection>(e =>
        {
            // The encrypted refresh token is a base64 AES-GCM blob (nonce|tag|ciphertext) — generous cap.
            e.Property(x => x.EncryptedRefreshToken).HasMaxLength(2048);
            e.Property(x => x.Scope).HasMaxLength(512);
            e.Property(x => x.GoogleCalendarId).HasMaxLength(256);
            e.Property(x => x.ConnectedUtc).HasColumnType("timestamp with time zone");
            e.Property(x => x.LastUsedUtc).HasColumnType("timestamp with time zone");
            // One calendar connection per user; also the lookup for "is this caller connected".
            e.HasIndex(x => x.UserId).IsUnique();
        });

        b.Entity<FamilyPlanPoll>(e =>
        {
            e.Property(x => x.Title).HasMaxLength(200);
            e.Property(x => x.Kind).HasMaxLength(16).HasDefaultValue("time");
            e.Property(x => x.CreatedUtc).HasColumnType("timestamp with time zone");
            // The family's poll list reads one household's polls (newest first by id).
            e.HasIndex(x => x.HouseholdId);
            e.HasMany(x => x.Options).WithOne(o => o.Poll!)
                .HasForeignKey(o => o.PollId).OnDelete(DeleteBehavior.Cascade);
        });

        b.Entity<FamilyPlanPollOption>(e =>
        {
            e.Property(x => x.Label).HasMaxLength(200);
            e.Property(x => x.StartUtc).HasColumnType("timestamp with time zone");
            e.Property(x => x.EndUtc).HasColumnType("timestamp with time zone");
            // Load a poll's options + tally votes by option.
            e.HasIndex(x => x.PollId);
            e.HasMany(x => x.Votes).WithOne(v => v.Option!)
                .HasForeignKey(v => v.OptionId).OnDelete(DeleteBehavior.Cascade);
        });

        b.Entity<FamilyPlanPollVote>(e =>
        {
            e.Property(x => x.CreatedUtc).HasColumnType("timestamp with time zone");
            // One vote per (option, member); also the lookup for "did this member already vote here".
            e.HasIndex(x => new { x.OptionId, x.UserId }).IsUnique();
        });

        b.Entity<FamilyEventAnnouncement>(e =>
        {
            e.Property(x => x.GoogleEventId).HasMaxLength(1024);
            e.Property(x => x.EventStartUtc).HasColumnType("timestamp with time zone");
            e.Property(x => x.AnnouncedUtc).HasColumnType("timestamp with time zone");
            // Announce-once: at most one row per (household, event). Also the dedup lookup in the tick.
            e.HasIndex(x => new { x.HouseholdId, x.GoogleEventId }).IsUnique();
        });

        b.Entity<CycleProfile>(e =>
        {
            e.Property(x => x.UserEmail).HasMaxLength(256);
            e.Property(x => x.AvgCycleLengthDays).HasDefaultValue(28);
            e.Property(x => x.AvgPeriodLengthDays).HasDefaultValue(5);
            e.Property(x => x.OverlayToFamily).HasDefaultValue(false);
            // One profile row per user; also the lookup for "this caller's cycle profile".
            e.HasIndex(x => x.UserEmail).IsUnique();
        });

        b.Entity<CyclePeriod>(e =>
        {
            e.Property(x => x.UserEmail).HasMaxLength(256);
            e.Property(x => x.LoggedUtc).HasColumnType("timestamp with time zone");
            // The own-history read filters by UserEmail and pages newest-start-first; this composite serves it
            // directly and also feeds the gap-based prediction.
            e.HasIndex(x => new { x.UserEmail, x.StartDate }).IsDescending(false, true);
        });

        b.Entity<CycleDayLog>(e =>
        {
            e.Property(x => x.UserEmail).HasMaxLength(256);
            e.Property(x => x.Mood).HasMaxLength(32);
            // Symptoms is a small fixed vocabulary stored as a Postgres text[] (mirrors ShareLink.Models).
            e.Property(x => x.Symptoms).HasColumnType("text[]");
            // FlowLevel persists as its int (none=0 .. heavy=4).
            e.Property(x => x.FlowLevel).HasConversion<int>().HasDefaultValue(CycleFlowLevel.None);
            e.Property(x => x.Notes).HasMaxLength(500);
            e.Property(x => x.CreatedUtc).HasColumnType("timestamp with time zone");
            e.Property(x => x.UpdatedUtc).HasColumnType("timestamp with time zone");
            // One day-log per (user, local date); also the per-date upsert/lookup + the recent read.
            e.HasIndex(x => new { x.UserEmail, x.LocalDate }).IsUnique();
        });

        // ---- Identity Map (owner-scoped: roles + time entries + classification rules) ----
        b.Entity<IdentityRole>(e =>
        {
            e.Property(x => x.UserEmail).HasMaxLength(256);
            e.Property(x => x.Name).HasMaxLength(64);
            e.Property(x => x.Color).HasMaxLength(16);
            e.Property(x => x.Archived).HasDefaultValue(false);
            e.Property(x => x.SortOrder).HasDefaultValue(0);
            e.Property(x => x.CreatedUtc).HasColumnType("timestamp with time zone");
            // A user can't have two roles with the same name; also resolves a rule's role-name to one row.
            e.HasIndex(x => new { x.UserEmail, x.Name }).IsUnique();
        });

        b.Entity<IdentityTimeEntry>(e =>
        {
            e.Property(x => x.UserEmail).HasMaxLength(256);
            e.Property(x => x.Source).HasConversion<int>();
            e.Property(x => x.SourceEventId).HasMaxLength(1024);
            e.Property(x => x.Note).HasMaxLength(256);
            e.Property(x => x.CreatedUtc).HasColumnType("timestamp with time zone");
            // The own-range read filters by UserEmail and pages newest-day-first; this composite serves it
            // directly and feeds the per-role minutes aggregation.
            e.HasIndex(x => new { x.UserEmail, x.Date }).IsDescending(false, true);
            // FILTERED UNIQUE: a Google event id is imported AT MOST ONCE per owner, so re-importing the same
            // window never double-counts. Manual entries (SourceEventId null) are exempt from the constraint.
            e.HasIndex(x => new { x.UserEmail, x.SourceEventId })
                .IsUnique()
                .HasFilter("\"SourceEventId\" IS NOT NULL");
            // Aggregation + cascade lookups by role.
            e.HasIndex(x => x.RoleId);
        });

        b.Entity<IdentityRule>(e =>
        {
            e.Property(x => x.UserEmail).HasMaxLength(256);
            e.Property(x => x.Keyword).HasMaxLength(128);
            e.Property(x => x.Priority).HasDefaultValue(0);
            e.Property(x => x.CreatedUtc).HasColumnType("timestamp with time zone");
            // Confirming the same mapping twice UPDATES rather than duplicates.
            e.HasIndex(x => new { x.UserEmail, x.Keyword }).IsUnique();
            e.HasIndex(x => x.RoleId);
        });

        b.Entity<HardChallenge>(e =>
        {
            e.Property(x => x.UserEmail).HasMaxLength(256);
            e.Property(x => x.CreatedUtc).HasColumnType("timestamp with time zone");
            e.Property(x => x.UpdatedUtc).HasColumnType("timestamp with time zone");
            // INVARIANT: at most one ACTIVE (Status=0) challenge per user. A FILTERED unique index lets a user
            // keep many completed/abandoned rows but only ever one active run; the start endpoint also catches
            // the unique violation. (Status=0 is HardChallengeStatus.Active.)
            e.HasIndex(x => x.UserEmail).IsUnique().HasFilter("\"Status\" = 0");
        });

        b.Entity<HardChallengeDay>(e =>
        {
            e.Property(x => x.UserEmail).HasMaxLength(256);
            e.Property(x => x.Confession).HasMaxLength(280);
            e.Property(x => x.NoAlcohol).HasDefaultValue(true);
            e.Property(x => x.DayPoints).HasColumnType("numeric(8,1)");
            e.Property(x => x.CreatedUtc).HasColumnType("timestamp with time zone");
            e.Property(x => x.UpdatedUtc).HasColumnType("timestamp with time zone");
            // One day row per (user, local date); also the day-grid read.
            e.HasIndex(x => new { x.UserEmail, x.LocalDate }).IsUnique();
            // Cascade the day rows with their owning challenge.
            e.HasOne(x => x.Challenge).WithMany()
                .HasForeignKey(x => x.ChallengeId).OnDelete(DeleteBehavior.Cascade);
        });

        b.Entity<HardChallengeTask>(e =>
        {
            e.Property(x => x.Key).HasMaxLength(64);
            e.Property(x => x.Label).HasMaxLength(120);
            e.Property(x => x.Unit).HasMaxLength(32);
            e.Property(x => x.TargetValue).HasColumnType("numeric(12,2)");
            e.Property(x => x.CreatedUtc).HasColumnType("timestamp with time zone");
            e.Property(x => x.UpdatedUtc).HasColumnType("timestamp with time zone");
            // A task Key is stable + unique within a challenge (day-progress rows reference the task by id).
            e.HasIndex(x => new { x.ChallengeId, x.Key }).IsUnique();
            // Cascade the task config with its owning challenge.
            e.HasOne(x => x.Challenge).WithMany(c => c.Tasks)
                .HasForeignKey(x => x.ChallengeId).OnDelete(DeleteBehavior.Cascade);
        });

        b.Entity<HardChallengeDayTask>(e =>
        {
            e.Property(x => x.UserEmail).HasMaxLength(256);
            e.Property(x => x.Value).HasColumnType("numeric(12,2)");
            e.Property(x => x.CreatedUtc).HasColumnType("timestamp with time zone");
            e.Property(x => x.UpdatedUtc).HasColumnType("timestamp with time zone");
            // One progress row per (user, local date, task).
            e.HasIndex(x => new { x.UserEmail, x.LocalDate, x.TaskId }).IsUnique();
            e.HasIndex(x => x.TaskId);
            // Cascade with the owning task (and thus the challenge).
            e.HasOne(x => x.Task).WithMany()
                .HasForeignKey(x => x.TaskId).OnDelete(DeleteBehavior.Cascade);
        });

        b.Entity<ActivityEvent>(e =>
        {
            e.Property(x => x.ActorEmail).HasMaxLength(256);
            e.Property(x => x.Kind).HasMaxLength(64);
            e.Property(x => x.Label).HasMaxLength(128);
            e.Property(x => x.CreatedUtc).HasColumnType("timestamp with time zone");
            // The feed pages newest-first across the viewer's circle (actor set + Id < before keyset); the
            // ActorEmail prefix also serves "this actor's events" and the own-events branch.
            e.HasIndex(x => new { x.ActorEmail, x.Id }).IsDescending(false, true);
            // Cross-actor keyset paging is ordered by Id desc.
            e.HasIndex(x => x.Id).IsDescending();
        });
    }
}
