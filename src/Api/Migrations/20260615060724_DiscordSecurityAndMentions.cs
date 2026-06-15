using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Ccusage.Api.Migrations
{
    /// <inheritdoc />
    public partial class DiscordSecurityAndMentions : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<long>(
                name: "LastAuditAlertId",
                table: "NotificationSettings",
                type: "bigint",
                nullable: false,
                defaultValue: 0L);

            migrationBuilder.AddColumn<string>(
                name: "MentionOnAlert",
                table: "NotificationSettings",
                type: "character varying(64)",
                maxLength: 64,
                nullable: true);

            migrationBuilder.AddColumn<bool>(
                name: "SecurityAlerts",
                table: "NotificationSettings",
                type: "boolean",
                nullable: false,
                defaultValue: false);

            migrationBuilder.UpdateData(
                table: "NotificationSettings",
                keyColumn: "Id",
                keyValue: 1,
                columns: new[] { "LastAuditAlertId", "MentionOnAlert", "SecurityAlerts" },
                values: new object[] { 0L, null, false });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "LastAuditAlertId",
                table: "NotificationSettings");

            migrationBuilder.DropColumn(
                name: "MentionOnAlert",
                table: "NotificationSettings");

            migrationBuilder.DropColumn(
                name: "SecurityAlerts",
                table: "NotificationSettings");
        }
    }
}
