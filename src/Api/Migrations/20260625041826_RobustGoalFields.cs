using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Ccusage.Api.Migrations
{
    /// <inheritdoc />
    public partial class RobustGoalFields : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<DateTime>(
                name: "BaselineReviewedUtc",
                table: "TrackerProfiles",
                type: "timestamp with time zone",
                nullable: true);

            migrationBuilder.AddColumn<double>(
                name: "BodyFatPct",
                table: "TrackerProfiles",
                type: "double precision",
                nullable: true);

            migrationBuilder.AddColumn<int>(
                name: "DietPattern",
                table: "TrackerProfiles",
                type: "integer",
                nullable: false,
                defaultValue: 0);

            migrationBuilder.AddColumn<int>(
                name: "EatingWindow",
                table: "TrackerProfiles",
                type: "integer",
                nullable: false,
                defaultValue: 0);

            migrationBuilder.AddColumn<double>(
                name: "GoalBasisWeightKg",
                table: "TrackerProfiles",
                type: "double precision",
                nullable: true);

            migrationBuilder.AddColumn<double>(
                name: "HipCm",
                table: "TrackerProfiles",
                type: "double precision",
                nullable: true);

            migrationBuilder.AddColumn<int>(
                name: "LifeStage",
                table: "TrackerProfiles",
                type: "integer",
                nullable: false,
                defaultValue: 0);

            migrationBuilder.AddColumn<int>(
                name: "MealsPerDay",
                table: "TrackerProfiles",
                type: "integer",
                nullable: true);

            migrationBuilder.AddColumn<double>(
                name: "NeckCm",
                table: "TrackerProfiles",
                type: "double precision",
                nullable: true);

            migrationBuilder.AddColumn<int>(
                name: "ProteinBasis",
                table: "TrackerProfiles",
                type: "integer",
                nullable: false,
                defaultValue: 0);

            migrationBuilder.AddColumn<string>(
                name: "Restrictions",
                table: "TrackerProfiles",
                type: "text",
                nullable: true);

            migrationBuilder.AddColumn<int>(
                name: "TrainingType",
                table: "TrackerProfiles",
                type: "integer",
                nullable: false,
                defaultValue: 0);

            migrationBuilder.AddColumn<int>(
                name: "Trimester",
                table: "TrackerProfiles",
                type: "integer",
                nullable: true);

            migrationBuilder.AddColumn<double>(
                name: "WaistCm",
                table: "TrackerProfiles",
                type: "double precision",
                nullable: true);

            migrationBuilder.AddColumn<double>(
                name: "WeeklyRateKg",
                table: "TrackerProfiles",
                type: "double precision",
                nullable: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "BaselineReviewedUtc",
                table: "TrackerProfiles");

            migrationBuilder.DropColumn(
                name: "BodyFatPct",
                table: "TrackerProfiles");

            migrationBuilder.DropColumn(
                name: "DietPattern",
                table: "TrackerProfiles");

            migrationBuilder.DropColumn(
                name: "EatingWindow",
                table: "TrackerProfiles");

            migrationBuilder.DropColumn(
                name: "GoalBasisWeightKg",
                table: "TrackerProfiles");

            migrationBuilder.DropColumn(
                name: "HipCm",
                table: "TrackerProfiles");

            migrationBuilder.DropColumn(
                name: "LifeStage",
                table: "TrackerProfiles");

            migrationBuilder.DropColumn(
                name: "MealsPerDay",
                table: "TrackerProfiles");

            migrationBuilder.DropColumn(
                name: "NeckCm",
                table: "TrackerProfiles");

            migrationBuilder.DropColumn(
                name: "ProteinBasis",
                table: "TrackerProfiles");

            migrationBuilder.DropColumn(
                name: "Restrictions",
                table: "TrackerProfiles");

            migrationBuilder.DropColumn(
                name: "TrainingType",
                table: "TrackerProfiles");

            migrationBuilder.DropColumn(
                name: "Trimester",
                table: "TrackerProfiles");

            migrationBuilder.DropColumn(
                name: "WaistCm",
                table: "TrackerProfiles");

            migrationBuilder.DropColumn(
                name: "WeeklyRateKg",
                table: "TrackerProfiles");
        }
    }
}
