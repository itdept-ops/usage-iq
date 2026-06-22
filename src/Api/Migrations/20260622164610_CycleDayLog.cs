using System;
using System.Collections.Generic;
using Microsoft.EntityFrameworkCore.Migrations;
using Npgsql.EntityFrameworkCore.PostgreSQL.Metadata;

#nullable disable

namespace Ccusage.Api.Migrations
{
    /// <inheritdoc />
    public partial class CycleDayLog : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "CycleDayLogs",
                columns: table => new
                {
                    Id = table.Column<int>(type: "integer", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    UserEmail = table.Column<string>(type: "character varying(256)", maxLength: 256, nullable: false),
                    UserId = table.Column<int>(type: "integer", nullable: false),
                    LocalDate = table.Column<DateOnly>(type: "date", nullable: false),
                    Mood = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: true),
                    Symptoms = table.Column<List<string>>(type: "text[]", nullable: false),
                    FlowLevel = table.Column<int>(type: "integer", nullable: false, defaultValue: 0),
                    Intimacy = table.Column<bool>(type: "boolean", nullable: false),
                    Protected = table.Column<bool>(type: "boolean", nullable: true),
                    Energy = table.Column<int>(type: "integer", nullable: true),
                    Notes = table.Column<string>(type: "character varying(500)", maxLength: 500, nullable: true),
                    CreatedUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    UpdatedUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_CycleDayLogs", x => x.Id);
                });

            migrationBuilder.CreateIndex(
                name: "IX_CycleDayLogs_UserEmail_LocalDate",
                table: "CycleDayLogs",
                columns: new[] { "UserEmail", "LocalDate" },
                unique: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "CycleDayLogs");
        }
    }
}
