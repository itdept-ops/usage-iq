using System;
using Microsoft.EntityFrameworkCore.Migrations;
using Npgsql.EntityFrameworkCore.PostgreSQL.Metadata;

#nullable disable

namespace Ccusage.Api.Migrations
{
    /// <inheritdoc />
    public partial class CycleTracking : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "CyclePeriods",
                columns: table => new
                {
                    Id = table.Column<int>(type: "integer", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    UserEmail = table.Column<string>(type: "character varying(256)", maxLength: 256, nullable: false),
                    UserId = table.Column<int>(type: "integer", nullable: false),
                    StartDate = table.Column<DateOnly>(type: "date", nullable: false),
                    EndDate = table.Column<DateOnly>(type: "date", nullable: true),
                    LoggedUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_CyclePeriods", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "CycleProfiles",
                columns: table => new
                {
                    Id = table.Column<int>(type: "integer", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    UserEmail = table.Column<string>(type: "character varying(256)", maxLength: 256, nullable: false),
                    UserId = table.Column<int>(type: "integer", nullable: false),
                    AvgCycleLengthDays = table.Column<int>(type: "integer", nullable: false, defaultValue: 28),
                    AvgPeriodLengthDays = table.Column<int>(type: "integer", nullable: false, defaultValue: 5),
                    OverlayToFamily = table.Column<bool>(type: "boolean", nullable: false, defaultValue: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_CycleProfiles", x => x.Id);
                });

            migrationBuilder.CreateIndex(
                name: "IX_CyclePeriods_UserEmail_StartDate",
                table: "CyclePeriods",
                columns: new[] { "UserEmail", "StartDate" },
                descending: new[] { false, true });

            migrationBuilder.CreateIndex(
                name: "IX_CycleProfiles_UserEmail",
                table: "CycleProfiles",
                column: "UserEmail",
                unique: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "CyclePeriods");

            migrationBuilder.DropTable(
                name: "CycleProfiles");
        }
    }
}
