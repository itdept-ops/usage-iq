using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

#pragma warning disable CA1814 // Prefer jagged arrays over multidimensional

namespace Ccusage.Api.Migrations
{
    /// <inheritdoc />
    public partial class GeminiPricing : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.InsertData(
                table: "ModelPricings",
                columns: new[] { "Id", "CacheReadPerMTok", "CacheWrite1hPerMTok", "CacheWrite5mPerMTok", "DisplayName", "InputPerMTok", "IsPlaceholder", "ModelPattern", "OutputPerMTok" },
                values: new object[,]
                {
                    { 12, 0.31m, 0m, 0m, "Gemini 3 Pro (estimated)", 1.25m, false, "gemini-3-pro", 10.00m },
                    { 13, 0.31m, 0m, 0m, "Gemini 3 (estimated)", 1.25m, false, "gemini-3", 10.00m }
                });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DeleteData(
                table: "ModelPricings",
                keyColumn: "Id",
                keyValue: 12);

            migrationBuilder.DeleteData(
                table: "ModelPricings",
                keyColumn: "Id",
                keyValue: 13);
        }
    }
}
