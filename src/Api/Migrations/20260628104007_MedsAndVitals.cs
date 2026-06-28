using System;
using Microsoft.EntityFrameworkCore.Migrations;
using Npgsql.EntityFrameworkCore.PostgreSQL.Metadata;

#nullable disable

namespace Ccusage.Api.Migrations
{
    /// <inheritdoc />
    public partial class MedsAndVitals : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "Medications",
                columns: table => new
                {
                    Id = table.Column<long>(type: "bigint", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    UserEmail = table.Column<string>(type: "character varying(256)", maxLength: 256, nullable: false),
                    UserId = table.Column<int>(type: "integer", nullable: false),
                    Name = table.Column<string>(type: "character varying(120)", maxLength: 120, nullable: false),
                    Dose = table.Column<string>(type: "character varying(60)", maxLength: 60, nullable: false),
                    Schedule = table.Column<string>(type: "jsonb", nullable: false),
                    Form = table.Column<int>(type: "integer", nullable: true),
                    Notes = table.Column<string>(type: "character varying(300)", maxLength: 300, nullable: true),
                    Active = table.Column<bool>(type: "boolean", nullable: false, defaultValue: true),
                    StartDate = table.Column<DateOnly>(type: "date", nullable: false),
                    EndDate = table.Column<DateOnly>(type: "date", nullable: true),
                    RemindersEnabled = table.Column<bool>(type: "boolean", nullable: false),
                    CreatedUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    UpdatedUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_Medications", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "VitalReadings",
                columns: table => new
                {
                    Id = table.Column<long>(type: "bigint", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    UserEmail = table.Column<string>(type: "character varying(256)", maxLength: 256, nullable: false),
                    UserId = table.Column<int>(type: "integer", nullable: false),
                    Kind = table.Column<int>(type: "integer", nullable: false),
                    Value1 = table.Column<decimal>(type: "numeric(8,2)", precision: 8, scale: 2, nullable: false),
                    Value2 = table.Column<decimal>(type: "numeric(8,2)", precision: 8, scale: 2, nullable: true),
                    Unit = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    LocalDate = table.Column<DateOnly>(type: "date", nullable: false),
                    MeasuredAtUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    Notes = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: true),
                    CreatedUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_VitalReadings", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "MedicationLogs",
                columns: table => new
                {
                    Id = table.Column<long>(type: "bigint", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    MedicationId = table.Column<long>(type: "bigint", nullable: false),
                    UserEmail = table.Column<string>(type: "character varying(256)", maxLength: 256, nullable: false),
                    LocalDate = table.Column<DateOnly>(type: "date", nullable: false),
                    ScheduledSlot = table.Column<int>(type: "integer", nullable: true),
                    Status = table.Column<int>(type: "integer", nullable: false),
                    TakenAtUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    Notes = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: true),
                    CreatedUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_MedicationLogs", x => x.Id);
                    table.ForeignKey(
                        name: "FK_MedicationLogs_Medications_MedicationId",
                        column: x => x.MedicationId,
                        principalTable: "Medications",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "IX_MedicationLogs_MedicationId_LocalDate",
                table: "MedicationLogs",
                columns: new[] { "MedicationId", "LocalDate" });

            migrationBuilder.CreateIndex(
                name: "IX_MedicationLogs_UserEmail_LocalDate",
                table: "MedicationLogs",
                columns: new[] { "UserEmail", "LocalDate" });

            migrationBuilder.CreateIndex(
                name: "IX_Medications_UserEmail_Active",
                table: "Medications",
                columns: new[] { "UserEmail", "Active" });

            migrationBuilder.CreateIndex(
                name: "IX_VitalReadings_UserEmail_Kind_LocalDate",
                table: "VitalReadings",
                columns: new[] { "UserEmail", "Kind", "LocalDate" });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "MedicationLogs");

            migrationBuilder.DropTable(
                name: "VitalReadings");

            migrationBuilder.DropTable(
                name: "Medications");
        }
    }
}
