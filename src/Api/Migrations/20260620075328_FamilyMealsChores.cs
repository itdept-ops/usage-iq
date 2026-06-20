using System;
using Microsoft.EntityFrameworkCore.Migrations;
using Npgsql.EntityFrameworkCore.PostgreSQL.Metadata;

#nullable disable

namespace Ccusage.Api.Migrations
{
    /// <inheritdoc />
    public partial class FamilyMealsChores : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "FamilyChores",
                columns: table => new
                {
                    Id = table.Column<long>(type: "bigint", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    HouseholdId = table.Column<int>(type: "integer", nullable: false),
                    Title = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: false),
                    AssignedToUserId = table.Column<int>(type: "integer", nullable: true),
                    Done = table.Column<bool>(type: "boolean", nullable: false),
                    DoneByUserId = table.Column<int>(type: "integer", nullable: true),
                    DoneUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    Points = table.Column<int>(type: "integer", nullable: false, defaultValue: 1),
                    Recurrence = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false, defaultValue: "none"),
                    CreatedByUserId = table.Column<int>(type: "integer", nullable: false),
                    CreatedUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_FamilyChores", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "FamilyMeals",
                columns: table => new
                {
                    Id = table.Column<long>(type: "bigint", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    HouseholdId = table.Column<int>(type: "integer", nullable: false),
                    LocalDate = table.Column<DateOnly>(type: "date", nullable: false),
                    Slot = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false, defaultValue: "dinner"),
                    Title = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: false),
                    Ingredients = table.Column<string>(type: "character varying(4000)", maxLength: 4000, nullable: false, defaultValue: ""),
                    CreatedByUserId = table.Column<int>(type: "integer", nullable: false),
                    CreatedUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_FamilyMeals", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "FamilyChoreCompletions",
                columns: table => new
                {
                    Id = table.Column<long>(type: "bigint", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    ChoreId = table.Column<long>(type: "bigint", nullable: false),
                    ByUserId = table.Column<int>(type: "integer", nullable: false),
                    AtUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    Points = table.Column<int>(type: "integer", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_FamilyChoreCompletions", x => x.Id);
                    table.ForeignKey(
                        name: "FK_FamilyChoreCompletions_FamilyChores_ChoreId",
                        column: x => x.ChoreId,
                        principalTable: "FamilyChores",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "IX_FamilyChoreCompletions_ByUserId",
                table: "FamilyChoreCompletions",
                column: "ByUserId");

            migrationBuilder.CreateIndex(
                name: "IX_FamilyChoreCompletions_ChoreId",
                table: "FamilyChoreCompletions",
                column: "ChoreId");

            migrationBuilder.CreateIndex(
                name: "IX_FamilyChores_Done_Recurrence",
                table: "FamilyChores",
                columns: new[] { "Done", "Recurrence" });

            migrationBuilder.CreateIndex(
                name: "IX_FamilyChores_HouseholdId",
                table: "FamilyChores",
                column: "HouseholdId");

            migrationBuilder.CreateIndex(
                name: "IX_FamilyMeals_HouseholdId_LocalDate",
                table: "FamilyMeals",
                columns: new[] { "HouseholdId", "LocalDate" });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "FamilyChoreCompletions");

            migrationBuilder.DropTable(
                name: "FamilyMeals");

            migrationBuilder.DropTable(
                name: "FamilyChores");
        }
    }
}
