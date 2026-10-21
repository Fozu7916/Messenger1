using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Messenger.Api.Data.Migrations
{
    /// <inheritdoc />
    public partial class AddMessageHides : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "message_hides",
                columns: table => new
                {
                    message_id = table.Column<string>(type: "character varying(26)", maxLength: 26, nullable: false, collation: "C"),
                    user_id = table.Column<string>(type: "character varying(26)", maxLength: 26, nullable: false, collation: "C"),
                    created_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false, defaultValueSql: "now()")
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_message_hides", x => new { x.message_id, x.user_id });
                    table.ForeignKey(
                        name: "fk_message_hides_messages_message_id",
                        column: x => x.message_id,
                        principalTable: "messages",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "fk_message_hides_users_user_id",
                        column: x => x.user_id,
                        principalTable: "users",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "ix_message_hides_user_id",
                table: "message_hides",
                column: "user_id");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "message_hides");
        }
    }
}
