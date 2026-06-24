using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Ccusage.Api.Migrations
{
    /// <inheritdoc />
    public partial class GeminiFlashPricing : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.InsertData(
                table: "ModelPricings",
                columns: new[] { "Id", "CacheReadPerMTok", "CacheWrite1hPerMTok", "CacheWrite5mPerMTok", "DisplayName", "InputPerMTok", "IsPlaceholder", "ModelPattern", "OutputPerMTok" },
                values: new object[] { 14, 0.075m, 0m, 0m, "Gemini 3.5 Flash (estimated)", 0.30m, false, "gemini-3.5-flash", 2.50m });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DeleteData(
                table: "ModelPricings",
                keyColumn: "Id",
                keyValue: 14);
        }
    }
}
