using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Messenger.Api.Data.Migrations
{
    /// <inheritdoc />
    [DbContext(typeof(AppDbContext))]
    [Migration("20261113120000_AddGroupsAndMedia")]
    public partial class AddGroupsAndMedia : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(name: "kind", table: "dialogs", type: "character varying(10)", maxLength: 10, nullable: false, defaultValue: "direct");
            migrationBuilder.AddColumn<string>(name: "title", table: "dialogs", type: "character varying(80)", maxLength: 80, nullable: true);
            migrationBuilder.AddColumn<string>(name: "avatar_url", table: "dialogs", type: "character varying(2048)", maxLength: 2048, nullable: true);
            migrationBuilder.AddColumn<string>(name: "created_by_id", table: "dialogs", type: "character varying(26)", maxLength: 26, nullable: true, collation: "C");
            migrationBuilder.AddColumn<string>(name: "role", table: "dialog_members", type: "character varying(10)", maxLength: 10, nullable: false, defaultValue: "member");
            migrationBuilder.AddColumn<string>(name: "kind", table: "messages", type: "character varying(10)", maxLength: 10, nullable: false, defaultValue: "text");
            migrationBuilder.AddColumn<int>(name: "media_width", table: "messages", type: "integer", nullable: true);
            migrationBuilder.AddColumn<int>(name: "media_height", table: "messages", type: "integer", nullable: true);
            migrationBuilder.AddColumn<int>(name: "media_duration_ms", table: "messages", type: "integer", nullable: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(name: "media_duration_ms", table: "messages");
            migrationBuilder.DropColumn(name: "media_height", table: "messages");
            migrationBuilder.DropColumn(name: "media_width", table: "messages");
            migrationBuilder.DropColumn(name: "kind", table: "messages");
            migrationBuilder.DropColumn(name: "role", table: "dialog_members");
            migrationBuilder.DropColumn(name: "created_by_id", table: "dialogs");
            migrationBuilder.DropColumn(name: "avatar_url", table: "dialogs");
            migrationBuilder.DropColumn(name: "title", table: "dialogs");
            migrationBuilder.DropColumn(name: "kind", table: "dialogs");
        }
    }
}
