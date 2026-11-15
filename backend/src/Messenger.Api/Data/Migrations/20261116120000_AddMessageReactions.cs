using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Messenger.Api.Data.Migrations
{
    /// <inheritdoc />
    [DbContext(typeof(AppDbContext))]
    [Migration("20261116120000_AddMessageReactions")]
    public partial class AddMessageReactions : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "message_reactions",
                columns: table => new
                {
                    message_id = table.Column<string>(type: "character varying(26)", maxLength: 26, nullable: false, collation: "C"),
                    user_id = table.Column<string>(type: "character varying(26)", maxLength: 26, nullable: false, collation: "C"),
                    dialog_id = table.Column<string>(type: "character varying(26)", maxLength: 26, nullable: false, collation: "C"),
                    emoji = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    created_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false, defaultValueSql: "now()")
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_message_reactions", x => new { x.message_id, x.user_id });
                    table.ForeignKey(
                        name: "fk_message_reactions_messages_message_id",
                        column: x => x.message_id,
                        principalTable: "messages",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "fk_message_reactions_users_user_id",
                        column: x => x.user_id,
                        principalTable: "users",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "ix_message_reactions_dialog_id",
                table: "message_reactions",
                column: "dialog_id");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(name: "message_reactions");
        }
    }
}
