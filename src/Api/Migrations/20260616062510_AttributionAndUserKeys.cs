using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Ccusage.Api.Migrations
{
    /// <inheritdoc />
    public partial class AttributionAndUserKeys : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "MachineName",
                table: "UsageRecords",
                type: "character varying(200)",
                maxLength: 200,
                nullable: false,
                defaultValue: "");

            migrationBuilder.AddColumn<string>(
                name: "ReportedByUser",
                table: "UsageRecords",
                type: "character varying(256)",
                maxLength: 256,
                nullable: false,
                defaultValue: "");

            migrationBuilder.AddColumn<int>(
                name: "UserId",
                table: "IngestKeys",
                type: "integer",
                nullable: true);

            migrationBuilder.CreateIndex(
                name: "IX_UsageRecords_MachineName",
                table: "UsageRecords",
                column: "MachineName");

            migrationBuilder.CreateIndex(
                name: "IX_UsageRecords_ReportedByUser",
                table: "UsageRecords",
                column: "ReportedByUser");

            migrationBuilder.CreateIndex(
                name: "IX_IngestKeys_UserId",
                table: "IngestKeys",
                column: "UserId");

            migrationBuilder.AddForeignKey(
                name: "FK_IngestKeys_Users_UserId",
                table: "IngestKeys",
                column: "UserId",
                principalTable: "Users",
                principalColumn: "Id",
                onDelete: ReferentialAction.SetNull);

            // Backfill ownership for pre-existing keys by matching CreatedByEmail to a user's Email
            // case-insensitively. Keys with no matching user (or a blank email) stay UserId NULL
            // (orphaned legacy keys). Raw-data backfill only — it does not touch the model snapshot.
            migrationBuilder.Sql(@"
                UPDATE ""IngestKeys"" k
                SET ""UserId"" = u.""Id""
                FROM ""Users"" u
                WHERE k.""UserId"" IS NULL
                  AND k.""CreatedByEmail"" <> ''
                  AND lower(k.""CreatedByEmail"") = lower(u.""Email"");
            ");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropForeignKey(
                name: "FK_IngestKeys_Users_UserId",
                table: "IngestKeys");

            migrationBuilder.DropIndex(
                name: "IX_UsageRecords_MachineName",
                table: "UsageRecords");

            migrationBuilder.DropIndex(
                name: "IX_UsageRecords_ReportedByUser",
                table: "UsageRecords");

            migrationBuilder.DropIndex(
                name: "IX_IngestKeys_UserId",
                table: "IngestKeys");

            migrationBuilder.DropColumn(
                name: "MachineName",
                table: "UsageRecords");

            migrationBuilder.DropColumn(
                name: "ReportedByUser",
                table: "UsageRecords");

            migrationBuilder.DropColumn(
                name: "UserId",
                table: "IngestKeys");
        }
    }
}
