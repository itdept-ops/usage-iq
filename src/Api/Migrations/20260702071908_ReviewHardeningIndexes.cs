using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Ccusage.Api.Migrations
{
    /// <inheritdoc />
    public partial class ReviewHardeningIndexes : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            // Data hygiene BEFORE the new foreign keys are added below, so this migration cannot fail
            // on a live database that already holds orphan rows (a pre-existing HouseholdMember whose
            // user was hard-deleted, or a day-task whose challenge was removed). These deletes only
            // remove rows that already reference a non-existent parent, and are no-ops on a clean DB.
            migrationBuilder.Sql(
                "DELETE FROM \"HouseholdMembers\" WHERE \"UserId\" IS NOT NULL " +
                "AND NOT EXISTS (SELECT 1 FROM \"Users\" u WHERE u.\"Id\" = \"HouseholdMembers\".\"UserId\");");
            migrationBuilder.Sql(
                "DELETE FROM \"HardChallengeDayTasks\" WHERE NOT EXISTS " +
                "(SELECT 1 FROM \"HardChallenges\" c WHERE c.\"Id\" = \"HardChallengeDayTasks\".\"ChallengeId\");");
            // The ModelPricings rows were HasData-seeded with explicit ids 1-14, which leaves the identity
            // sequence un-advanced; without this, the first runtime POST /api/pricing insert collides on the
            // primary key. Advance the sequence past the max seeded id (no-op if already advanced).
            migrationBuilder.Sql(
                "SELECT setval(pg_get_serial_sequence('\"ModelPricings\"','Id'), " +
                "GREATEST((SELECT COALESCE(MAX(\"Id\"), 1) FROM \"ModelPricings\"), 1), true);");

            migrationBuilder.DropForeignKey(
                name: "FK_UsageRecords_IngestedFiles_IngestedFileId",
                table: "UsageRecords");

            migrationBuilder.AlterColumn<int>(
                name: "IngestedFileId",
                table: "UsageRecords",
                type: "integer",
                nullable: true,
                oldClrType: typeof(int),
                oldType: "integer");

            migrationBuilder.CreateIndex(
                name: "IX_UsageRecords_CostUsd",
                table: "UsageRecords",
                column: "CostUsd",
                descending: new bool[0]);

            migrationBuilder.CreateIndex(
                name: "IX_UsageRecords_InputTokens",
                table: "UsageRecords",
                column: "InputTokens",
                descending: new bool[0]);

            migrationBuilder.CreateIndex(
                name: "IX_UsageRecords_LocalDate_TimestampUtc",
                table: "UsageRecords",
                columns: new[] { "LocalDate", "TimestampUtc" },
                descending: new[] { false, true });

            migrationBuilder.CreateIndex(
                name: "IX_UsageRecords_OutputTokens",
                table: "UsageRecords",
                column: "OutputTokens",
                descending: new bool[0]);

            migrationBuilder.CreateIndex(
                name: "IX_UsageRecords_TimestampUtc",
                table: "UsageRecords",
                column: "TimestampUtc",
                descending: new bool[0]);

            migrationBuilder.AddCheckConstraint(
                name: "CK_ShareAccess_OneLink",
                table: "ShareAccesses",
                sql: "num_nonnulls(\"ShareLinkId\", \"WrappedShareLinkId\") = 1");

            migrationBuilder.CreateIndex(
                name: "IX_HardChallengeDayTasks_ChallengeId",
                table: "HardChallengeDayTasks",
                column: "ChallengeId");

            migrationBuilder.CreateIndex(
                name: "IX_FinanceBudgets_HouseholdId",
                table: "FinanceBudgets",
                column: "HouseholdId",
                unique: true,
                filter: "\"Category\" IS NULL");

            migrationBuilder.CreateIndex(
                name: "IX_AiUsageLogs_Feature",
                table: "AiUsageLogs",
                column: "Feature");

            migrationBuilder.CreateIndex(
                name: "IX_AiUsageLogs_Model",
                table: "AiUsageLogs",
                column: "Model");

            migrationBuilder.CreateIndex(
                name: "IX_AiUsageLogs_Outcome",
                table: "AiUsageLogs",
                column: "Outcome");

            migrationBuilder.AddForeignKey(
                name: "FK_HardChallengeDayTasks_HardChallenges_ChallengeId",
                table: "HardChallengeDayTasks",
                column: "ChallengeId",
                principalTable: "HardChallenges",
                principalColumn: "Id",
                onDelete: ReferentialAction.Cascade);

            migrationBuilder.AddForeignKey(
                name: "FK_HouseholdMembers_Users_UserId",
                table: "HouseholdMembers",
                column: "UserId",
                principalTable: "Users",
                principalColumn: "Id",
                onDelete: ReferentialAction.Cascade);

            migrationBuilder.AddForeignKey(
                name: "FK_UsageRecords_IngestedFiles_IngestedFileId",
                table: "UsageRecords",
                column: "IngestedFileId",
                principalTable: "IngestedFiles",
                principalColumn: "Id",
                onDelete: ReferentialAction.SetNull);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropForeignKey(
                name: "FK_HardChallengeDayTasks_HardChallenges_ChallengeId",
                table: "HardChallengeDayTasks");

            migrationBuilder.DropForeignKey(
                name: "FK_HouseholdMembers_Users_UserId",
                table: "HouseholdMembers");

            migrationBuilder.DropForeignKey(
                name: "FK_UsageRecords_IngestedFiles_IngestedFileId",
                table: "UsageRecords");

            migrationBuilder.DropIndex(
                name: "IX_UsageRecords_CostUsd",
                table: "UsageRecords");

            migrationBuilder.DropIndex(
                name: "IX_UsageRecords_InputTokens",
                table: "UsageRecords");

            migrationBuilder.DropIndex(
                name: "IX_UsageRecords_LocalDate_TimestampUtc",
                table: "UsageRecords");

            migrationBuilder.DropIndex(
                name: "IX_UsageRecords_OutputTokens",
                table: "UsageRecords");

            migrationBuilder.DropIndex(
                name: "IX_UsageRecords_TimestampUtc",
                table: "UsageRecords");

            migrationBuilder.DropCheckConstraint(
                name: "CK_ShareAccess_OneLink",
                table: "ShareAccesses");

            migrationBuilder.DropIndex(
                name: "IX_HardChallengeDayTasks_ChallengeId",
                table: "HardChallengeDayTasks");

            migrationBuilder.DropIndex(
                name: "IX_FinanceBudgets_HouseholdId",
                table: "FinanceBudgets");

            migrationBuilder.DropIndex(
                name: "IX_AiUsageLogs_Feature",
                table: "AiUsageLogs");

            migrationBuilder.DropIndex(
                name: "IX_AiUsageLogs_Model",
                table: "AiUsageLogs");

            migrationBuilder.DropIndex(
                name: "IX_AiUsageLogs_Outcome",
                table: "AiUsageLogs");

            migrationBuilder.AlterColumn<int>(
                name: "IngestedFileId",
                table: "UsageRecords",
                type: "integer",
                nullable: false,
                defaultValue: 0,
                oldClrType: typeof(int),
                oldType: "integer",
                oldNullable: true);

            migrationBuilder.AddForeignKey(
                name: "FK_UsageRecords_IngestedFiles_IngestedFileId",
                table: "UsageRecords",
                column: "IngestedFileId",
                principalTable: "IngestedFiles",
                principalColumn: "Id",
                onDelete: ReferentialAction.Cascade);
        }
    }
}
