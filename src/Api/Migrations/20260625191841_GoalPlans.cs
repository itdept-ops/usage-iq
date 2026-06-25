using System;
using Microsoft.EntityFrameworkCore.Migrations;
using Npgsql.EntityFrameworkCore.PostgreSQL.Metadata;

#nullable disable

namespace Ccusage.Api.Migrations
{
    /// <inheritdoc />
    public partial class GoalPlans : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "GoalPlans",
                columns: table => new
                {
                    Id = table.Column<long>(type: "bigint", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    UserEmail = table.Column<string>(type: "character varying(256)", maxLength: 256, nullable: false),
                    EffectiveFrom = table.Column<DateOnly>(type: "date", nullable: false),
                    Goal = table.Column<int>(type: "integer", nullable: false),
                    WeeklyRateKg = table.Column<double>(type: "double precision", nullable: true),
                    DailyCalorieGoal = table.Column<int>(type: "integer", nullable: true),
                    ProteinGoalG = table.Column<int>(type: "integer", nullable: true),
                    CarbGoalG = table.Column<int>(type: "integer", nullable: true),
                    FatGoalG = table.Column<int>(type: "integer", nullable: true),
                    WeightKg = table.Column<double>(type: "double precision", nullable: true),
                    BodyFatPct = table.Column<double>(type: "double precision", nullable: true),
                    ActivityLevel = table.Column<int>(type: "integer", nullable: false),
                    DietPattern = table.Column<int>(type: "integer", nullable: false),
                    CreatedUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_GoalPlans", x => x.Id);
                });

            migrationBuilder.CreateIndex(
                name: "IX_GoalPlans_UserEmail_EffectiveFrom",
                table: "GoalPlans",
                columns: new[] { "UserEmail", "EffectiveFrom" },
                unique: true,
                descending: new[] { false, true });

            // BACKFILL: one initial GoalPlan per existing TrackerProfile, copied from its CURRENT targets,
            // effective from the 0001-01-01 sentinel (DateOnly.MinValue) so EVERY historical day resolves to
            // it (the resolver's EffectiveFrom <= D holds for any real date). One row per profile is safe —
            // there is exactly one profile per user (TrackerProfiles.UserEmail is unique), so the new unique
            // (UserEmail, EffectiveFrom) index can't collide. Profiles with no numeric goal yield a plan with
            // null numeric targets, and the day-build then falls back to suggestions exactly as before — so
            // nothing loses its goal, even goal-less profiles. Raw SQL because it copies live profile columns.
            migrationBuilder.Sql("""
                INSERT INTO "GoalPlans"
                    ("UserEmail", "EffectiveFrom", "Goal", "WeeklyRateKg",
                     "DailyCalorieGoal", "ProteinGoalG", "CarbGoalG", "FatGoalG",
                     "WeightKg", "BodyFatPct", "ActivityLevel", "DietPattern", "CreatedUtc")
                SELECT
                    p."UserEmail", DATE '0001-01-01', p."Goal", p."WeeklyRateKg",
                    p."DailyCalorieGoal", p."ProteinGoalG", p."CarbGoalG", p."FatGoalG",
                    p."WeightKg", p."BodyFatPct", p."ActivityLevel", p."DietPattern", now()
                FROM "TrackerProfiles" p;
                """);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "GoalPlans");
        }
    }
}
