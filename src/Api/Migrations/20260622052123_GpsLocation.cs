using System;
using Microsoft.EntityFrameworkCore.Migrations;
using Npgsql.EntityFrameworkCore.PostgreSQL.Metadata;

#nullable disable

namespace Ccusage.Api.Migrations
{
    /// <inheritdoc />
    public partial class GpsLocation : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<bool>(
                name: "LocationEnabled",
                table: "Users",
                type: "boolean",
                nullable: false,
                defaultValue: false);

            migrationBuilder.AddColumn<bool>(
                name: "LocationShareHousehold",
                table: "Users",
                type: "boolean",
                nullable: false,
                defaultValue: false);

            migrationBuilder.AddColumn<string>(
                name: "City",
                table: "MachineInfos",
                type: "character varying(120)",
                maxLength: 120,
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "Country",
                table: "MachineInfos",
                type: "character varying(120)",
                maxLength: 120,
                nullable: true);

            migrationBuilder.AddColumn<DateTime>(
                name: "GeoUpdatedUtc",
                table: "MachineInfos",
                type: "timestamp with time zone",
                nullable: true);

            migrationBuilder.AddColumn<double>(
                name: "Lat",
                table: "MachineInfos",
                type: "double precision",
                nullable: true);

            migrationBuilder.AddColumn<double>(
                name: "Lng",
                table: "MachineInfos",
                type: "double precision",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "Region",
                table: "MachineInfos",
                type: "character varying(120)",
                maxLength: 120,
                nullable: true);

            migrationBuilder.CreateTable(
                name: "UserLocations",
                columns: table => new
                {
                    Id = table.Column<int>(type: "integer", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    UserEmail = table.Column<string>(type: "character varying(256)", maxLength: 256, nullable: false),
                    Lat = table.Column<double>(type: "double precision", nullable: false),
                    Lng = table.Column<double>(type: "double precision", nullable: false),
                    AccuracyM = table.Column<double>(type: "double precision", nullable: true),
                    Source = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false, defaultValue: "manual"),
                    City = table.Column<string>(type: "character varying(120)", maxLength: 120, nullable: true),
                    Region = table.Column<string>(type: "character varying(120)", maxLength: 120, nullable: true),
                    Country = table.Column<string>(type: "character varying(120)", maxLength: 120, nullable: true),
                    CapturedUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_UserLocations", x => x.Id);
                });

            migrationBuilder.CreateIndex(
                name: "IX_UserLocations_UserEmail_CapturedUtc",
                table: "UserLocations",
                columns: new[] { "UserEmail", "CapturedUtc" },
                descending: new[] { false, true });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "UserLocations");

            migrationBuilder.DropColumn(
                name: "LocationEnabled",
                table: "Users");

            migrationBuilder.DropColumn(
                name: "LocationShareHousehold",
                table: "Users");

            migrationBuilder.DropColumn(
                name: "City",
                table: "MachineInfos");

            migrationBuilder.DropColumn(
                name: "Country",
                table: "MachineInfos");

            migrationBuilder.DropColumn(
                name: "GeoUpdatedUtc",
                table: "MachineInfos");

            migrationBuilder.DropColumn(
                name: "Lat",
                table: "MachineInfos");

            migrationBuilder.DropColumn(
                name: "Lng",
                table: "MachineInfos");

            migrationBuilder.DropColumn(
                name: "Region",
                table: "MachineInfos");
        }
    }
}
