using System;
using Microsoft.EntityFrameworkCore.Migrations;
using Npgsql.EntityFrameworkCore.PostgreSQL.Metadata;

#nullable disable

namespace Ccusage.Api.Migrations
{
    /// <inheritdoc />
    public partial class NotificationSettings : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "NotificationSettings",
                columns: table => new
                {
                    Id = table.Column<int>(type: "integer", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    DiscordWebhookUrl = table.Column<string>(type: "character varying(512)", maxLength: 512, nullable: true),
                    Enabled = table.Column<bool>(type: "boolean", nullable: false),
                    DigestHourLocal = table.Column<int>(type: "integer", nullable: false),
                    DailyDigest = table.Column<bool>(type: "boolean", nullable: false),
                    WeeklyDigest = table.Column<bool>(type: "boolean", nullable: false),
                    WeeklyDay = table.Column<int>(type: "integer", nullable: false),
                    ThresholdEnabled = table.Column<bool>(type: "boolean", nullable: false),
                    ThresholdUsd = table.Column<decimal>(type: "numeric(18,2)", precision: 18, scale: 2, nullable: false),
                    LastDailySent = table.Column<DateOnly>(type: "date", nullable: true),
                    LastWeeklySent = table.Column<DateOnly>(type: "date", nullable: true),
                    LastThresholdSent = table.Column<DateOnly>(type: "date", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_NotificationSettings", x => x.Id);
                });

            migrationBuilder.InsertData(
                table: "NotificationSettings",
                columns: new[] { "Id", "DailyDigest", "DigestHourLocal", "DiscordWebhookUrl", "Enabled", "LastDailySent", "LastThresholdSent", "LastWeeklySent", "ThresholdEnabled", "ThresholdUsd", "WeeklyDay", "WeeklyDigest" },
                values: new object[] { 1, false, 9, null, false, null, null, null, false, 0m, 1, false });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "NotificationSettings");
        }
    }
}
