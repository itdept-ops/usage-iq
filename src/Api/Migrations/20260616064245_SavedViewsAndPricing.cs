using System;
using Microsoft.EntityFrameworkCore.Migrations;
using Npgsql.EntityFrameworkCore.PostgreSQL.Metadata;

#nullable disable

namespace Ccusage.Api.Migrations
{
    /// <inheritdoc />
    public partial class SavedViewsAndPricing : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "SavedViews",
                columns: table => new
                {
                    Id = table.Column<int>(type: "integer", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    UserId = table.Column<int>(type: "integer", nullable: false),
                    Name = table.Column<string>(type: "character varying(80)", maxLength: 80, nullable: false),
                    FromDate = table.Column<DateOnly>(type: "date", nullable: true),
                    ToDate = table.Column<DateOnly>(type: "date", nullable: true),
                    ProjectIdsCsv = table.Column<string>(type: "character varying(2048)", maxLength: 2048, nullable: false, defaultValue: ""),
                    ModelsCsv = table.Column<string>(type: "character varying(2048)", maxLength: 2048, nullable: false, defaultValue: ""),
                    SourcesCsv = table.Column<string>(type: "character varying(512)", maxLength: 512, nullable: false, defaultValue: ""),
                    IncludeSidechain = table.Column<bool>(type: "boolean", nullable: false, defaultValue: true),
                    GroupBy = table.Column<string>(type: "character varying(20)", maxLength: 20, nullable: false, defaultValue: "day"),
                    CreatedUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    LastUsedUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_SavedViews", x => x.Id);
                    table.ForeignKey(
                        name: "FK_SavedViews_Users_UserId",
                        column: x => x.UserId,
                        principalTable: "Users",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.UpdateData(
                table: "ModelPricings",
                keyColumn: "Id",
                keyValue: 4,
                columns: new[] { "CacheReadPerMTok", "CacheWrite1hPerMTok", "CacheWrite5mPerMTok", "DisplayName", "InputPerMTok", "IsPlaceholder", "OutputPerMTok" },
                values: new object[] { 1.50m, 30m, 18.75m, "Claude Fable 5 (estimated)", 15m, false, 75m });

            migrationBuilder.CreateIndex(
                name: "IX_SavedViews_UserId_Name",
                table: "SavedViews",
                columns: new[] { "UserId", "Name" });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "SavedViews");

            migrationBuilder.UpdateData(
                table: "ModelPricings",
                keyColumn: "Id",
                keyValue: 4,
                columns: new[] { "CacheReadPerMTok", "CacheWrite1hPerMTok", "CacheWrite5mPerMTok", "DisplayName", "InputPerMTok", "IsPlaceholder", "OutputPerMTok" },
                values: new object[] { 0.30m, 6.00m, 3.75m, "Claude Fable 5 (placeholder)", 3.00m, true, 15.00m });
        }
    }
}
