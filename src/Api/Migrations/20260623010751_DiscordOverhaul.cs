using Microsoft.EntityFrameworkCore.Migrations;
using Npgsql.EntityFrameworkCore.PostgreSQL.Metadata;

#nullable disable

#pragma warning disable CA1814 // Prefer jagged arrays over multidimensional

namespace Ccusage.Api.Migrations
{
    /// <inheritdoc />
    public partial class DiscordOverhaul : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "DiscordWebhookEnc",
                table: "NotificationPreferences",
                type: "character varying(2048)",
                maxLength: 2048,
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "DiscordWebhookHint",
                table: "NotificationPreferences",
                type: "character varying(120)",
                maxLength: 120,
                nullable: true);

            migrationBuilder.AddColumn<bool>(
                name: "SurfaceDiscord",
                table: "NotificationPreferences",
                type: "boolean",
                nullable: false,
                defaultValue: false);

            migrationBuilder.CreateTable(
                name: "DiscordRoutes",
                columns: table => new
                {
                    Id = table.Column<int>(type: "integer", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    EventKey = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    Label = table.Column<string>(type: "character varying(120)", maxLength: 120, nullable: false),
                    Enabled = table.Column<bool>(type: "boolean", nullable: false),
                    Mention = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: true),
                    SortOrder = table.Column<int>(type: "integer", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_DiscordRoutes", x => x.Id);
                });

            migrationBuilder.InsertData(
                table: "DiscordRoutes",
                columns: new[] { "Id", "Enabled", "EventKey", "Label", "Mention", "SortOrder" },
                values: new object[,]
                {
                    { 1, false, "daily-digest", "Daily digest", null, 1 },
                    { 2, false, "weekly-digest", "Weekly digest", null, 2 },
                    { 3, false, "spend-threshold", "Spend threshold alert", null, 3 },
                    { 4, false, "security-alerts", "Security alerts", null, 4 },
                    { 5, false, "new-user-signup", "New user signup", null, 5 }
                });

            migrationBuilder.CreateIndex(
                name: "IX_DiscordRoutes_EventKey",
                table: "DiscordRoutes",
                column: "EventKey",
                unique: true);

            // Preserve live config: copy the existing NotificationSetting boolean flags into the seeded
            // routes' Enabled so digests/threshold/security keep forwarding exactly as before. The routing
            // table is now the source of truth for WHICH events forward; these flags become legacy.
            migrationBuilder.Sql(@"
                UPDATE ""DiscordRoutes"" r SET ""Enabled"" = COALESCE(s.flag, false)
                FROM (SELECT ""DailyDigest"" AS flag FROM ""NotificationSettings"" WHERE ""Id"" = 1) s
                WHERE r.""EventKey"" = 'daily-digest';");
            migrationBuilder.Sql(@"
                UPDATE ""DiscordRoutes"" r SET ""Enabled"" = COALESCE(s.flag, false)
                FROM (SELECT ""WeeklyDigest"" AS flag FROM ""NotificationSettings"" WHERE ""Id"" = 1) s
                WHERE r.""EventKey"" = 'weekly-digest';");
            migrationBuilder.Sql(@"
                UPDATE ""DiscordRoutes"" r SET ""Enabled"" = COALESCE(s.flag, false)
                FROM (SELECT ""ThresholdEnabled"" AS flag FROM ""NotificationSettings"" WHERE ""Id"" = 1) s
                WHERE r.""EventKey"" = 'spend-threshold';");
            migrationBuilder.Sql(@"
                UPDATE ""DiscordRoutes"" r SET ""Enabled"" = COALESCE(s.flag, false)
                FROM (SELECT ""SecurityAlerts"" AS flag FROM ""NotificationSettings"" WHERE ""Id"" = 1) s
                WHERE r.""EventKey"" = 'security-alerts';");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "DiscordRoutes");

            migrationBuilder.DropColumn(
                name: "DiscordWebhookEnc",
                table: "NotificationPreferences");

            migrationBuilder.DropColumn(
                name: "DiscordWebhookHint",
                table: "NotificationPreferences");

            migrationBuilder.DropColumn(
                name: "SurfaceDiscord",
                table: "NotificationPreferences");
        }
    }
}
