using System;
using Microsoft.EntityFrameworkCore.Migrations;
using Npgsql.EntityFrameworkCore.PostgreSQL.Metadata;

#nullable disable

namespace Ccusage.Api.Migrations
{
    /// <inheritdoc />
    public partial class CoffeeTracking : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<int>(
                name: "CoffeeGoalCups",
                table: "TrackerProfiles",
                type: "integer",
                nullable: true);

            migrationBuilder.CreateTable(
                name: "CoffeeEntries",
                columns: table => new
                {
                    Id = table.Column<long>(type: "bigint", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    UserEmail = table.Column<string>(type: "character varying(256)", maxLength: 256, nullable: false),
                    LocalDate = table.Column<DateOnly>(type: "date", nullable: false),
                    Cups = table.Column<int>(type: "integer", nullable: false),
                    CaffeineMg = table.Column<int>(type: "integer", nullable: true),
                    Label = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: true),
                    CreatedUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_CoffeeEntries", x => x.Id);
                });

            migrationBuilder.CreateIndex(
                name: "IX_CoffeeEntries_UserEmail_LocalDate",
                table: "CoffeeEntries",
                columns: new[] { "UserEmail", "LocalDate" });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "CoffeeEntries");

            migrationBuilder.DropColumn(
                name: "CoffeeGoalCups",
                table: "TrackerProfiles");
        }
    }
}
