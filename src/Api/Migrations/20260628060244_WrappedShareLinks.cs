using System;
using Microsoft.EntityFrameworkCore.Migrations;
using Npgsql.EntityFrameworkCore.PostgreSQL.Metadata;

#nullable disable

namespace Ccusage.Api.Migrations
{
    /// <inheritdoc />
    public partial class WrappedShareLinks : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AlterColumn<int>(
                name: "ShareLinkId",
                table: "ShareAccesses",
                type: "integer",
                nullable: true,
                oldClrType: typeof(int),
                oldType: "integer");

            migrationBuilder.AddColumn<int>(
                name: "WrappedShareLinkId",
                table: "ShareAccesses",
                type: "integer",
                nullable: true);

            migrationBuilder.CreateTable(
                name: "WrappedShareLinks",
                columns: table => new
                {
                    Id = table.Column<int>(type: "integer", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    TokenHash = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    TokenEnc = table.Column<string>(type: "character varying(256)", maxLength: 256, nullable: true),
                    Label = table.Column<string>(type: "character varying(120)", maxLength: 120, nullable: true),
                    CreatedByEmail = table.Column<string>(type: "character varying(256)", maxLength: 256, nullable: false),
                    CreatedUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    ExpiresUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    OwnerEmail = table.Column<string>(type: "character varying(256)", maxLength: 256, nullable: false),
                    Period = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    FromDate = table.Column<DateOnly>(type: "date", nullable: false),
                    ToDate = table.Column<DateOnly>(type: "date", nullable: false),
                    CardWhitelist = table.Column<string[]>(type: "text[]", nullable: false),
                    NarrativeSnapshot = table.Column<string>(type: "text", nullable: false),
                    InsightsSnapshot = table.Column<string[]>(type: "text[]", nullable: false),
                    AccessCount = table.Column<int>(type: "integer", nullable: false),
                    LastAccessedUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_WrappedShareLinks", x => x.Id);
                });

            migrationBuilder.CreateIndex(
                name: "IX_ShareAccesses_WrappedShareLinkId_WhenUtc",
                table: "ShareAccesses",
                columns: new[] { "WrappedShareLinkId", "WhenUtc" });

            migrationBuilder.CreateIndex(
                name: "IX_WrappedShareLinks_TokenHash",
                table: "WrappedShareLinks",
                column: "TokenHash",
                unique: true);

            migrationBuilder.AddForeignKey(
                name: "FK_ShareAccesses_WrappedShareLinks_WrappedShareLinkId",
                table: "ShareAccesses",
                column: "WrappedShareLinkId",
                principalTable: "WrappedShareLinks",
                principalColumn: "Id",
                onDelete: ReferentialAction.Cascade);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropForeignKey(
                name: "FK_ShareAccesses_WrappedShareLinks_WrappedShareLinkId",
                table: "ShareAccesses");

            migrationBuilder.DropTable(
                name: "WrappedShareLinks");

            migrationBuilder.DropIndex(
                name: "IX_ShareAccesses_WrappedShareLinkId_WhenUtc",
                table: "ShareAccesses");

            migrationBuilder.DropColumn(
                name: "WrappedShareLinkId",
                table: "ShareAccesses");

            migrationBuilder.AlterColumn<int>(
                name: "ShareLinkId",
                table: "ShareAccesses",
                type: "integer",
                nullable: false,
                defaultValue: 0,
                oldClrType: typeof(int),
                oldType: "integer",
                oldNullable: true);
        }
    }
}
