using System;
using Microsoft.EntityFrameworkCore.Migrations;
using Npgsql.EntityFrameworkCore.PostgreSQL.Metadata;

#nullable disable

namespace Ccusage.Api.Migrations
{
    /// <inheritdoc />
    public partial class ChoreMarketplaceAllowance : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<int>(
                name: "ApprovedByUserId",
                table: "FamilyChores",
                type: "integer",
                nullable: true);

            migrationBuilder.AddColumn<DateTime>(
                name: "ApprovedUtc",
                table: "FamilyChores",
                type: "timestamp with time zone",
                nullable: true);

            migrationBuilder.AddColumn<int>(
                name: "ClaimedByUserId",
                table: "FamilyChores",
                type: "integer",
                nullable: true);

            migrationBuilder.AddColumn<DateTime>(
                name: "ClaimedUtc",
                table: "FamilyChores",
                type: "timestamp with time zone",
                nullable: true);

            migrationBuilder.AddColumn<decimal>(
                name: "CreditValue",
                table: "FamilyChores",
                type: "numeric(10,2)",
                precision: 10,
                scale: 2,
                nullable: false,
                defaultValue: 0m);

            migrationBuilder.AddColumn<string>(
                name: "Source",
                table: "FamilyChores",
                type: "character varying(16)",
                maxLength: 16,
                nullable: false,
                defaultValue: "assigned");

            migrationBuilder.AddColumn<string>(
                name: "Status",
                table: "FamilyChores",
                type: "character varying(16)",
                maxLength: 16,
                nullable: false,
                defaultValue: "open");

            migrationBuilder.AddColumn<decimal>(
                name: "Credits",
                table: "FamilyChoreCompletions",
                type: "numeric(10,2)",
                precision: 10,
                scale: 2,
                nullable: false,
                defaultValue: 0m);

            migrationBuilder.CreateTable(
                name: "FamilyCreditEntries",
                columns: table => new
                {
                    Id = table.Column<long>(type: "bigint", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    HouseholdId = table.Column<int>(type: "integer", nullable: false),
                    ChildUserId = table.Column<int>(type: "integer", nullable: false),
                    Kind = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false, defaultValue: "earn"),
                    Amount = table.Column<decimal>(type: "numeric(10,2)", precision: 10, scale: 2, nullable: false),
                    Category = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: true),
                    ChoreCompletionId = table.Column<long>(type: "bigint", nullable: true),
                    Note = table.Column<string>(type: "character varying(256)", maxLength: 256, nullable: true),
                    CreatedByUserId = table.Column<int>(type: "integer", nullable: false),
                    CreatedUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_FamilyCreditEntries", x => x.Id);
                    table.ForeignKey(
                        name: "FK_FamilyCreditEntries_FamilyChoreCompletions_ChoreCompletionId",
                        column: x => x.ChoreCompletionId,
                        principalTable: "FamilyChoreCompletions",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.SetNull);
                });

            migrationBuilder.CreateIndex(
                name: "IX_FamilyChores_ClaimedByUserId",
                table: "FamilyChores",
                column: "ClaimedByUserId");

            migrationBuilder.CreateIndex(
                name: "IX_FamilyChores_HouseholdId_Status",
                table: "FamilyChores",
                columns: new[] { "HouseholdId", "Status" });

            migrationBuilder.CreateIndex(
                name: "IX_FamilyCreditEntries_ChoreCompletionId",
                table: "FamilyCreditEntries",
                column: "ChoreCompletionId");

            migrationBuilder.CreateIndex(
                name: "IX_FamilyCreditEntries_HouseholdId_ChildUserId",
                table: "FamilyCreditEntries",
                columns: new[] { "HouseholdId", "ChildUserId" });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "FamilyCreditEntries");

            migrationBuilder.DropIndex(
                name: "IX_FamilyChores_ClaimedByUserId",
                table: "FamilyChores");

            migrationBuilder.DropIndex(
                name: "IX_FamilyChores_HouseholdId_Status",
                table: "FamilyChores");

            migrationBuilder.DropColumn(
                name: "ApprovedByUserId",
                table: "FamilyChores");

            migrationBuilder.DropColumn(
                name: "ApprovedUtc",
                table: "FamilyChores");

            migrationBuilder.DropColumn(
                name: "ClaimedByUserId",
                table: "FamilyChores");

            migrationBuilder.DropColumn(
                name: "ClaimedUtc",
                table: "FamilyChores");

            migrationBuilder.DropColumn(
                name: "CreditValue",
                table: "FamilyChores");

            migrationBuilder.DropColumn(
                name: "Source",
                table: "FamilyChores");

            migrationBuilder.DropColumn(
                name: "Status",
                table: "FamilyChores");

            migrationBuilder.DropColumn(
                name: "Credits",
                table: "FamilyChoreCompletions");
        }
    }
}
