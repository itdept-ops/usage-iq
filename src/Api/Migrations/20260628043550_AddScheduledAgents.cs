using System;
using Microsoft.EntityFrameworkCore.Migrations;
using Npgsql.EntityFrameworkCore.PostgreSQL.Metadata;

#nullable disable

namespace Ccusage.Api.Migrations
{
    /// <inheritdoc />
    public partial class AddScheduledAgents : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "ScheduledAgents",
                columns: table => new
                {
                    Id = table.Column<int>(type: "integer", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    UserEmail = table.Column<string>(type: "character varying(256)", maxLength: 256, nullable: false),
                    Kind = table.Column<int>(type: "integer", nullable: false),
                    Enabled = table.Column<bool>(type: "boolean", nullable: false),
                    DeliverHourLocal = table.Column<int>(type: "integer", nullable: false),
                    QuietStartLocalHour = table.Column<int>(type: "integer", nullable: true),
                    QuietEndLocalHour = table.Column<int>(type: "integer", nullable: true),
                    TimeZone = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false, defaultValue: "America/New_York"),
                    LastFiredLocalDate = table.Column<DateOnly>(type: "date", nullable: true),
                    LastFiredKey = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: true),
                    CreatedUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    UpdatedUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_ScheduledAgents", x => x.Id);
                });

            migrationBuilder.CreateIndex(
                name: "IX_ScheduledAgents_Enabled_LastFiredLocalDate",
                table: "ScheduledAgents",
                columns: new[] { "Enabled", "LastFiredLocalDate" });

            migrationBuilder.CreateIndex(
                name: "IX_ScheduledAgents_UserEmail_Kind",
                table: "ScheduledAgents",
                columns: new[] { "UserEmail", "Kind" },
                unique: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "ScheduledAgents");
        }
    }
}
