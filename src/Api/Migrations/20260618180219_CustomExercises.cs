using System;
using Microsoft.EntityFrameworkCore.Migrations;
using Npgsql.EntityFrameworkCore.PostgreSQL.Metadata;

#nullable disable

namespace Ccusage.Api.Migrations
{
    /// <inheritdoc />
    public partial class CustomExercises : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "CustomExercises",
                columns: table => new
                {
                    Id = table.Column<long>(type: "bigint", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    UserEmail = table.Column<string>(type: "character varying(256)", maxLength: 256, nullable: false),
                    Name = table.Column<string>(type: "character varying(128)", maxLength: 128, nullable: false),
                    NameKey = table.Column<string>(type: "character varying(128)", maxLength: 128, nullable: false),
                    DefaultCaloriesBurned = table.Column<int>(type: "integer", nullable: true),
                    DefaultDurationMin = table.Column<int>(type: "integer", nullable: true),
                    UseCount = table.Column<int>(type: "integer", nullable: false),
                    CreatedUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    LastUsedUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_CustomExercises", x => x.Id);
                });

            migrationBuilder.CreateIndex(
                name: "IX_CustomExercises_UserEmail_LastUsedUtc",
                table: "CustomExercises",
                columns: new[] { "UserEmail", "LastUsedUtc" });

            migrationBuilder.CreateIndex(
                name: "IX_CustomExercises_UserEmail_NameKey",
                table: "CustomExercises",
                columns: new[] { "UserEmail", "NameKey" },
                unique: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "CustomExercises");
        }
    }
}
