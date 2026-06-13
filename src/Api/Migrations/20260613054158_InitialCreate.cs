using System;
using Microsoft.EntityFrameworkCore.Migrations;
using Npgsql.EntityFrameworkCore.PostgreSQL.Metadata;

#nullable disable

#pragma warning disable CA1814 // Prefer jagged arrays over multidimensional

namespace Ccusage.Api.Migrations
{
    /// <inheritdoc />
    public partial class InitialCreate : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "AppConfigs",
                columns: table => new
                {
                    Id = table.Column<int>(type: "integer", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    DisplayTimeZone = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    ClaudeProjectsPath = table.Column<string>(type: "character varying(1024)", maxLength: 1024, nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_AppConfigs", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "IngestedFiles",
                columns: table => new
                {
                    Id = table.Column<int>(type: "integer", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    Path = table.Column<string>(type: "character varying(1024)", maxLength: 1024, nullable: false),
                    LastModifiedUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    SizeBytes = table.Column<long>(type: "bigint", nullable: false),
                    LinesIngested = table.Column<int>(type: "integer", nullable: false),
                    LastSyncUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_IngestedFiles", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "ModelPricings",
                columns: table => new
                {
                    Id = table.Column<int>(type: "integer", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    ModelPattern = table.Column<string>(type: "character varying(128)", maxLength: 128, nullable: false),
                    DisplayName = table.Column<string>(type: "character varying(128)", maxLength: 128, nullable: true),
                    InputPerMTok = table.Column<decimal>(type: "numeric(12,4)", precision: 12, scale: 4, nullable: false),
                    OutputPerMTok = table.Column<decimal>(type: "numeric(12,4)", precision: 12, scale: 4, nullable: false),
                    CacheWrite5mPerMTok = table.Column<decimal>(type: "numeric(12,4)", precision: 12, scale: 4, nullable: false),
                    CacheWrite1hPerMTok = table.Column<decimal>(type: "numeric(12,4)", precision: 12, scale: 4, nullable: false),
                    CacheReadPerMTok = table.Column<decimal>(type: "numeric(12,4)", precision: 12, scale: 4, nullable: false),
                    IsPlaceholder = table.Column<bool>(type: "boolean", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_ModelPricings", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "Projects",
                columns: table => new
                {
                    Id = table.Column<int>(type: "integer", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    Name = table.Column<string>(type: "character varying(256)", maxLength: 256, nullable: false),
                    RepoRoot = table.Column<string>(type: "character varying(1024)", maxLength: 1024, nullable: false),
                    FolderName = table.Column<string>(type: "character varying(512)", maxLength: 512, nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_Projects", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "UsageRecords",
                columns: table => new
                {
                    Id = table.Column<long>(type: "bigint", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    MessageId = table.Column<string>(type: "character varying(128)", maxLength: 128, nullable: false),
                    RequestId = table.Column<string>(type: "character varying(128)", maxLength: 128, nullable: true),
                    DedupKey = table.Column<string>(type: "character varying(300)", maxLength: 300, nullable: false),
                    TimestampUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    LocalDate = table.Column<DateOnly>(type: "date", nullable: false),
                    Model = table.Column<string>(type: "character varying(128)", maxLength: 128, nullable: false),
                    InputTokens = table.Column<int>(type: "integer", nullable: false),
                    OutputTokens = table.Column<int>(type: "integer", nullable: false),
                    CacheReadTokens = table.Column<long>(type: "bigint", nullable: false),
                    CacheCreation5mTokens = table.Column<int>(type: "integer", nullable: false),
                    CacheCreation1hTokens = table.Column<int>(type: "integer", nullable: false),
                    SessionId = table.Column<string>(type: "character varying(128)", maxLength: 128, nullable: false),
                    ProjectId = table.Column<int>(type: "integer", nullable: false),
                    Cwd = table.Column<string>(type: "text", nullable: false),
                    GitBranch = table.Column<string>(type: "character varying(256)", maxLength: 256, nullable: true),
                    IsSidechain = table.Column<bool>(type: "boolean", nullable: false),
                    AgentId = table.Column<string>(type: "character varying(128)", maxLength: 128, nullable: true),
                    Version = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: true),
                    CostUsd = table.Column<decimal>(type: "numeric(18,8)", precision: 18, scale: 8, nullable: false),
                    IngestedFileId = table.Column<int>(type: "integer", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_UsageRecords", x => x.Id);
                    table.ForeignKey(
                        name: "FK_UsageRecords_IngestedFiles_IngestedFileId",
                        column: x => x.IngestedFileId,
                        principalTable: "IngestedFiles",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "FK_UsageRecords_Projects_ProjectId",
                        column: x => x.ProjectId,
                        principalTable: "Projects",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.InsertData(
                table: "ModelPricings",
                columns: new[] { "Id", "CacheReadPerMTok", "CacheWrite1hPerMTok", "CacheWrite5mPerMTok", "DisplayName", "InputPerMTok", "IsPlaceholder", "ModelPattern", "OutputPerMTok" },
                values: new object[,]
                {
                    { 1, 1.50m, 30m, 18.75m, "Claude Opus 4.8", 15m, false, "claude-opus-4-8", 75m },
                    { 2, 1.50m, 30m, 18.75m, "Claude Opus 4.7", 15m, false, "claude-opus-4-7", 75m },
                    { 3, 0.10m, 2.00m, 1.25m, "Claude Haiku 4.5", 1.00m, false, "claude-haiku-4-5", 5.00m },
                    { 4, 0.30m, 6.00m, 3.75m, "Claude Fable 5 (placeholder)", 3.00m, true, "claude-fable-5", 15.00m },
                    { 5, 0m, 0m, 0m, "Unpriced fallback", 0m, true, "*", 0m }
                });

            migrationBuilder.CreateIndex(
                name: "IX_IngestedFiles_Path",
                table: "IngestedFiles",
                column: "Path",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_ModelPricings_ModelPattern",
                table: "ModelPricings",
                column: "ModelPattern",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_Projects_RepoRoot",
                table: "Projects",
                column: "RepoRoot",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_UsageRecords_DedupKey",
                table: "UsageRecords",
                column: "DedupKey",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_UsageRecords_IngestedFileId",
                table: "UsageRecords",
                column: "IngestedFileId");

            migrationBuilder.CreateIndex(
                name: "IX_UsageRecords_IsSidechain",
                table: "UsageRecords",
                column: "IsSidechain");

            migrationBuilder.CreateIndex(
                name: "IX_UsageRecords_LocalDate",
                table: "UsageRecords",
                column: "LocalDate");

            migrationBuilder.CreateIndex(
                name: "IX_UsageRecords_Model",
                table: "UsageRecords",
                column: "Model");

            migrationBuilder.CreateIndex(
                name: "IX_UsageRecords_ProjectId_LocalDate",
                table: "UsageRecords",
                columns: new[] { "ProjectId", "LocalDate" });

            migrationBuilder.CreateIndex(
                name: "IX_UsageRecords_SessionId",
                table: "UsageRecords",
                column: "SessionId");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "AppConfigs");

            migrationBuilder.DropTable(
                name: "ModelPricings");

            migrationBuilder.DropTable(
                name: "UsageRecords");

            migrationBuilder.DropTable(
                name: "IngestedFiles");

            migrationBuilder.DropTable(
                name: "Projects");
        }
    }
}
