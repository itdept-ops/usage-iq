using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Ccusage.Api.Migrations
{
    /// <inheritdoc />
    public partial class FamilyTodayBriefing : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<bool>(
                name: "BriefingEnabled",
                table: "Households",
                type: "boolean",
                nullable: false,
                defaultValue: true);

            migrationBuilder.AddColumn<int>(
                name: "BriefingHourLocal",
                table: "Households",
                type: "integer",
                nullable: false,
                defaultValue: 7);

            migrationBuilder.AddColumn<int>(
                name: "FamilyChannelId",
                table: "Households",
                type: "integer",
                nullable: true);

            migrationBuilder.AddColumn<DateOnly>(
                name: "LastBriefingLocalDate",
                table: "Households",
                type: "date",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "TimeZone",
                table: "Households",
                type: "character varying(64)",
                maxLength: 64,
                nullable: false,
                defaultValue: "America/New_York");

            migrationBuilder.AddColumn<string>(
                name: "WeatherLocation",
                table: "Households",
                type: "character varying(120)",
                maxLength: 120,
                nullable: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "BriefingEnabled",
                table: "Households");

            migrationBuilder.DropColumn(
                name: "BriefingHourLocal",
                table: "Households");

            migrationBuilder.DropColumn(
                name: "FamilyChannelId",
                table: "Households");

            migrationBuilder.DropColumn(
                name: "LastBriefingLocalDate",
                table: "Households");

            migrationBuilder.DropColumn(
                name: "TimeZone",
                table: "Households");

            migrationBuilder.DropColumn(
                name: "WeatherLocation",
                table: "Households");
        }
    }
}
