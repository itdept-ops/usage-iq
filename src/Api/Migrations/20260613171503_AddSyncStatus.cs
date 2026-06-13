using System;
using Microsoft.EntityFrameworkCore.Migrations;
using Npgsql.EntityFrameworkCore.PostgreSQL.Metadata;

#nullable disable

namespace Ccusage.Api.Migrations
{
    /// <inheritdoc />
    public partial class AddSyncStatus : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "SyncStatuses",
                columns: table => new
                {
                    Id = table.Column<int>(type: "integer", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    LastSyncUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    LastNewRecords = table.Column<int>(type: "integer", nullable: false),
                    LastDurationMs = table.Column<long>(type: "bigint", nullable: false),
                    LastFilesParsed = table.Column<int>(type: "integer", nullable: false),
                    LastFilesScanned = table.Column<int>(type: "integer", nullable: false),
                    LastError = table.Column<string>(type: "text", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_SyncStatuses", x => x.Id);
                });

            migrationBuilder.InsertData(
                table: "SyncStatuses",
                columns: new[] { "Id", "LastDurationMs", "LastError", "LastFilesParsed", "LastFilesScanned", "LastNewRecords", "LastSyncUtc" },
                values: new object[] { 1, 0L, null, 0, 0, 0, null });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "SyncStatuses");
        }
    }
}
