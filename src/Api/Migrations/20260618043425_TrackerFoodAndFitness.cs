using System;
using Microsoft.EntityFrameworkCore.Migrations;
using Npgsql.EntityFrameworkCore.PostgreSQL.Metadata;

#nullable disable

namespace Ccusage.Api.Migrations
{
    /// <inheritdoc />
    public partial class TrackerFoodAndFitness : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "ExerciseLibrary",
                columns: table => new
                {
                    Id = table.Column<int>(type: "integer", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    Name = table.Column<string>(type: "character varying(128)", maxLength: 128, nullable: false),
                    Category = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    Met = table.Column<double>(type: "double precision", nullable: false),
                    GoalTags = table.Column<string>(type: "character varying(128)", maxLength: 128, nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_ExerciseLibrary", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "FoodEntries",
                columns: table => new
                {
                    Id = table.Column<long>(type: "bigint", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    UserEmail = table.Column<string>(type: "character varying(256)", maxLength: 256, nullable: false),
                    LocalDate = table.Column<DateOnly>(type: "date", nullable: false),
                    Meal = table.Column<int>(type: "integer", nullable: false),
                    FdcId = table.Column<int>(type: "integer", nullable: true),
                    Description = table.Column<string>(type: "character varying(256)", maxLength: 256, nullable: false),
                    Brand = table.Column<string>(type: "character varying(256)", maxLength: 256, nullable: true),
                    Quantity = table.Column<double>(type: "double precision", nullable: false),
                    ServingDesc = table.Column<string>(type: "character varying(128)", maxLength: 128, nullable: true),
                    Calories = table.Column<int>(type: "integer", nullable: false),
                    ProteinG = table.Column<double>(type: "double precision", nullable: false),
                    CarbG = table.Column<double>(type: "double precision", nullable: false),
                    FatG = table.Column<double>(type: "double precision", nullable: false),
                    CreatedUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_FoodEntries", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "TrackerProfiles",
                columns: table => new
                {
                    Id = table.Column<int>(type: "integer", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    UserEmail = table.Column<string>(type: "character varying(256)", maxLength: 256, nullable: false),
                    Goal = table.Column<int>(type: "integer", nullable: false),
                    WeightKg = table.Column<double>(type: "double precision", nullable: true),
                    DailyCalorieGoal = table.Column<int>(type: "integer", nullable: true),
                    ProteinGoalG = table.Column<int>(type: "integer", nullable: true),
                    CarbGoalG = table.Column<int>(type: "integer", nullable: true),
                    FatGoalG = table.Column<int>(type: "integer", nullable: true),
                    ShareWithContacts = table.Column<bool>(type: "boolean", nullable: false),
                    UpdatedUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_TrackerProfiles", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "ExerciseEntries",
                columns: table => new
                {
                    Id = table.Column<long>(type: "bigint", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    UserEmail = table.Column<string>(type: "character varying(256)", maxLength: 256, nullable: false),
                    LocalDate = table.Column<DateOnly>(type: "date", nullable: false),
                    ExerciseId = table.Column<int>(type: "integer", nullable: true),
                    Name = table.Column<string>(type: "character varying(128)", maxLength: 128, nullable: false),
                    DurationMin = table.Column<int>(type: "integer", nullable: true),
                    CaloriesBurned = table.Column<int>(type: "integer", nullable: false),
                    CreatedUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_ExerciseEntries", x => x.Id);
                    table.ForeignKey(
                        name: "FK_ExerciseEntries_ExerciseLibrary_ExerciseId",
                        column: x => x.ExerciseId,
                        principalTable: "ExerciseLibrary",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.SetNull);
                });

            migrationBuilder.CreateIndex(
                name: "IX_ExerciseEntries_ExerciseId",
                table: "ExerciseEntries",
                column: "ExerciseId");

            migrationBuilder.CreateIndex(
                name: "IX_ExerciseEntries_UserEmail_LocalDate",
                table: "ExerciseEntries",
                columns: new[] { "UserEmail", "LocalDate" });

            migrationBuilder.CreateIndex(
                name: "IX_FoodEntries_UserEmail_LocalDate",
                table: "FoodEntries",
                columns: new[] { "UserEmail", "LocalDate" });

            migrationBuilder.CreateIndex(
                name: "IX_TrackerProfiles_UserEmail",
                table: "TrackerProfiles",
                column: "UserEmail",
                unique: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "ExerciseEntries");

            migrationBuilder.DropTable(
                name: "FoodEntries");

            migrationBuilder.DropTable(
                name: "TrackerProfiles");

            migrationBuilder.DropTable(
                name: "ExerciseLibrary");
        }
    }
}
