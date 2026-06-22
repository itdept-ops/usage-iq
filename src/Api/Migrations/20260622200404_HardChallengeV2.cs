using System;
using Microsoft.EntityFrameworkCore.Migrations;
using Npgsql.EntityFrameworkCore.PostgreSQL.Metadata;

#nullable disable

namespace Ccusage.Api.Migrations
{
    /// <inheritdoc />
    public partial class HardChallengeV2 : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            // The new DayPoints cache column (defaults to 0; recomputed live on every read).
            migrationBuilder.AddColumn<decimal>(
                name: "DayPoints",
                table: "HardChallengeDays",
                type: "numeric(8,1)",
                nullable: false,
                defaultValue: 0m);

            migrationBuilder.CreateTable(
                name: "HardChallengeTasks",
                columns: table => new
                {
                    Id = table.Column<int>(type: "integer", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    ChallengeId = table.Column<int>(type: "integer", nullable: false),
                    Key = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    Label = table.Column<string>(type: "character varying(120)", maxLength: 120, nullable: false),
                    AutoSource = table.Column<int>(type: "integer", nullable: false),
                    TargetValue = table.Column<decimal>(type: "numeric(12,2)", nullable: true),
                    MinMinutes = table.Column<int>(type: "integer", nullable: true),
                    Unit = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: false),
                    PointValue = table.Column<int>(type: "integer", nullable: false),
                    PartialCredit = table.Column<bool>(type: "boolean", nullable: false),
                    Enabled = table.Column<bool>(type: "boolean", nullable: false),
                    SortOrder = table.Column<int>(type: "integer", nullable: false),
                    CreatedUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    UpdatedUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_HardChallengeTasks", x => x.Id);
                    table.ForeignKey(
                        name: "FK_HardChallengeTasks_HardChallenges_ChallengeId",
                        column: x => x.ChallengeId,
                        principalTable: "HardChallenges",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "HardChallengeDayTasks",
                columns: table => new
                {
                    Id = table.Column<long>(type: "bigint", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    ChallengeId = table.Column<int>(type: "integer", nullable: false),
                    TaskId = table.Column<int>(type: "integer", nullable: false),
                    UserEmail = table.Column<string>(type: "character varying(256)", maxLength: 256, nullable: false),
                    LocalDate = table.Column<DateOnly>(type: "date", nullable: false),
                    Value = table.Column<decimal>(type: "numeric(12,2)", nullable: true),
                    Done = table.Column<bool>(type: "boolean", nullable: true),
                    CreatedUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    UpdatedUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_HardChallengeDayTasks", x => x.Id);
                    table.ForeignKey(
                        name: "FK_HardChallengeDayTasks_HardChallengeTasks_TaskId",
                        column: x => x.TaskId,
                        principalTable: "HardChallengeTasks",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "IX_HardChallengeDayTasks_TaskId",
                table: "HardChallengeDayTasks",
                column: "TaskId");

            migrationBuilder.CreateIndex(
                name: "IX_HardChallengeDayTasks_UserEmail_LocalDate_TaskId",
                table: "HardChallengeDayTasks",
                columns: new[] { "UserEmail", "LocalDate", "TaskId" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_HardChallengeTasks_ChallengeId_Key",
                table: "HardChallengeTasks",
                columns: new[] { "ChallengeId", "Key" },
                unique: true);

            // ============================================================================
            // BACKFILL — every EXISTING challenge (active or not) gets the DEFAULT v2 task
            // set seeded, so v1 runs keep scoring. AutoSource ints: 1=Diet 2=Water 3=Workout
            // 4=NoAlcohol 0=None. All 10-point; water/workout/reading allow partial credit.
            // ============================================================================
            migrationBuilder.Sql(@"
INSERT INTO ""HardChallengeTasks""
    (""ChallengeId"", ""Key"", ""Label"", ""AutoSource"", ""TargetValue"", ""MinMinutes"", ""Unit"",
     ""PointValue"", ""PartialCredit"", ""Enabled"", ""SortOrder"", ""CreatedUtc"", ""UpdatedUtc"")
SELECT c.""Id"", v.key, v.label, v.src, v.target, v.minmin, v.unit,
       10, v.partial, TRUE, v.sort, now(), now()
FROM ""HardChallenges"" c
CROSS JOIN (VALUES
    ('diet',       'Follow a diet',           1, NULL,         NULL, '',         FALSE, 0),
    ('water',      'Drink a gallon of water', 2, 3785,         NULL, 'ml',       TRUE,  1),
    ('workout',    'Two 45-minute workouts',  3, 2,            45,   'workouts', TRUE,  2),
    ('reading',    'Read 10 pages',           0, 10,           NULL, 'pages',    TRUE,  3),
    ('no-alcohol', 'No alcohol',              4, NULL,         NULL, '',         FALSE, 4)
) AS v(key, label, src, target, minmin, unit, partial, sort)
WHERE NOT EXISTS (
    SELECT 1 FROM ""HardChallengeTasks"" t WHERE t.""ChallengeId"" = c.""Id"" AND t.""Key"" = v.key
);");

            // BACKFILL old day rows: a day that had ReadOk=true maps to the reading task at its full
            // 10-page target (so the day's reading credit survives). Water/workout/diet recompute live
            // from the tracker, NoAlcohol + DietOverride already live on the day row, so only reading
            // needs a progress row. (Old day rows without ReadOk simply seed defaults / recompute.)
            migrationBuilder.Sql(@"
INSERT INTO ""HardChallengeDayTasks""
    (""ChallengeId"", ""TaskId"", ""UserEmail"", ""LocalDate"", ""Value"", ""Done"", ""CreatedUtc"", ""UpdatedUtc"")
SELECT d.""ChallengeId"", t.""Id"", d.""UserEmail"", d.""LocalDate"", 10, NULL, now(), now()
FROM ""HardChallengeDays"" d
JOIN ""HardChallengeTasks"" t ON t.""ChallengeId"" = d.""ChallengeId"" AND t.""Key"" = 'reading'
WHERE d.""ReadOk"" = TRUE
  AND NOT EXISTS (
    SELECT 1 FROM ""HardChallengeDayTasks"" x
    WHERE x.""UserEmail"" = d.""UserEmail"" AND x.""LocalDate"" = d.""LocalDate"" AND x.""TaskId"" = t.""Id""
);");

            // Now that the old day booleans have been mapped, DROP the v1 fixed-task columns. PhotoTaken
            // is dropped entirely (the progress-photo concept is GONE in v2).
            migrationBuilder.DropColumn(name: "DietOk", table: "HardChallengeDays");
            migrationBuilder.DropColumn(name: "PhotoTaken", table: "HardChallengeDays");
            migrationBuilder.DropColumn(name: "ReadOk", table: "HardChallengeDays");
            migrationBuilder.DropColumn(name: "WaterGallonOk", table: "HardChallengeDays");
            migrationBuilder.DropColumn(name: "Workout1Ok", table: "HardChallengeDays");
            migrationBuilder.DropColumn(name: "Workout2Ok", table: "HardChallengeDays");
            migrationBuilder.DropColumn(name: "Workout2Outdoor", table: "HardChallengeDays");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "HardChallengeDayTasks");

            migrationBuilder.DropTable(
                name: "HardChallengeTasks");

            migrationBuilder.DropColumn(
                name: "DayPoints",
                table: "HardChallengeDays");

            migrationBuilder.AddColumn<bool>(
                name: "DietOk",
                table: "HardChallengeDays",
                type: "boolean",
                nullable: false,
                defaultValue: false);

            migrationBuilder.AddColumn<bool>(
                name: "PhotoTaken",
                table: "HardChallengeDays",
                type: "boolean",
                nullable: false,
                defaultValue: false);

            migrationBuilder.AddColumn<bool>(
                name: "ReadOk",
                table: "HardChallengeDays",
                type: "boolean",
                nullable: false,
                defaultValue: false);

            migrationBuilder.AddColumn<bool>(
                name: "WaterGallonOk",
                table: "HardChallengeDays",
                type: "boolean",
                nullable: false,
                defaultValue: false);

            migrationBuilder.AddColumn<bool>(
                name: "Workout1Ok",
                table: "HardChallengeDays",
                type: "boolean",
                nullable: false,
                defaultValue: false);

            migrationBuilder.AddColumn<bool>(
                name: "Workout2Ok",
                table: "HardChallengeDays",
                type: "boolean",
                nullable: false,
                defaultValue: false);

            migrationBuilder.AddColumn<bool>(
                name: "Workout2Outdoor",
                table: "HardChallengeDays",
                type: "boolean",
                nullable: false,
                defaultValue: false);
        }
    }
}
