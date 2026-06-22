using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Ccusage.Api.Migrations
{
    /// <inheritdoc />
    public partial class MealMacros : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<int>(
                name: "Calories",
                table: "FamilyMeals",
                type: "integer",
                nullable: false,
                defaultValue: 0);

            migrationBuilder.AddColumn<double>(
                name: "CarbG",
                table: "FamilyMeals",
                type: "double precision",
                nullable: false,
                defaultValue: 0.0);

            migrationBuilder.AddColumn<double>(
                name: "FatG",
                table: "FamilyMeals",
                type: "double precision",
                nullable: false,
                defaultValue: 0.0);

            migrationBuilder.AddColumn<string>(
                name: "MacroSource",
                table: "FamilyMeals",
                type: "character varying(16)",
                maxLength: 16,
                nullable: false,
                defaultValue: "none");

            migrationBuilder.AddColumn<double>(
                name: "ProteinG",
                table: "FamilyMeals",
                type: "double precision",
                nullable: false,
                defaultValue: 0.0);

            migrationBuilder.AddColumn<int>(
                name: "Servings",
                table: "FamilyMeals",
                type: "integer",
                nullable: false,
                defaultValue: 1);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "Calories",
                table: "FamilyMeals");

            migrationBuilder.DropColumn(
                name: "CarbG",
                table: "FamilyMeals");

            migrationBuilder.DropColumn(
                name: "FatG",
                table: "FamilyMeals");

            migrationBuilder.DropColumn(
                name: "MacroSource",
                table: "FamilyMeals");

            migrationBuilder.DropColumn(
                name: "ProteinG",
                table: "FamilyMeals");

            migrationBuilder.DropColumn(
                name: "Servings",
                table: "FamilyMeals");
        }
    }
}
