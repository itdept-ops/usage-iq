using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Ccusage.Api.Migrations
{
    /// <summary>
    /// Drops the DB store default (127) on NotificationPreferences.DiscordCategories. With a store default,
    /// EF Core treats a property value of 0 as "unset" and writes the default instead — so a user explicitly
    /// turning OFF all seven Discord categories (mask 0) would silently persist as 127 and keep forwarding
    /// EVERYTHING. Dropping the default lets an explicit all-off (0) persist literally. New rows still default
    /// to All via the entity's CLR initializer; existing/backfilled rows keep their 127 value (this only alters
    /// the column DEFAULT, not stored data).
    /// </summary>
    public partial class DiscordCategoriesDropStoreDefault : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AlterColumn<int>(
                name: "DiscordCategories",
                table: "NotificationPreferences",
                type: "integer",
                nullable: false,
                oldClrType: typeof(int),
                oldType: "integer",
                oldDefaultValue: 127);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AlterColumn<int>(
                name: "DiscordCategories",
                table: "NotificationPreferences",
                type: "integer",
                nullable: false,
                defaultValue: 127,
                oldClrType: typeof(int),
                oldType: "integer");
        }
    }
}
