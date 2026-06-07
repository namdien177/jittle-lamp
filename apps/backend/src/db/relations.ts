import { relations } from "drizzle-orm";

import { desktopRecordingSessions } from "./tables/desktop-recording-sessions";
import { evidenceArtifacts } from "./tables/evidence-artifacts";
import { evidenceComments } from "./tables/evidence-comments";
import { evidences } from "./tables/evidences";
import { organizationActivityLogs } from "./tables/organization-activity-logs";
import { organizationInvitationCodes } from "./tables/organization-invitation-codes";
import { organizationInvitations } from "./tables/organization-invitations";
import { organizationJoinRequests } from "./tables/organization-join-requests";
import { organizationMembers } from "./tables/organization-members";
import { organizationRoles } from "./tables/organization-roles";
import { organizations } from "./tables/organizations";
import { provisioningEvents } from "./tables/provisioning-events";
import { shareLinks } from "./tables/share-links";
import { users } from "./tables/users";

export const usersRelations = relations(users, ({ many }) => ({
	organizationMemberships: many(organizationMembers),
	provisioningEvents: many(provisioningEvents),
	createdEvidences: many(evidences),
	evidenceComments: many(evidenceComments),
	createdShareLinks: many(shareLinks),
	desktopRecordingSessions: many(desktopRecordingSessions),
	sentInvitations: many(organizationInvitations, {
		relationName: "invitedByUser",
	}),
	createdInvitationCodes: many(organizationInvitationCodes),
	organizationActivityLogs: many(organizationActivityLogs),
	organizationJoinRequests: many(organizationJoinRequests),
}));

export const organizationsRelations = relations(
	organizations,
	({ many, one }) => ({
		owner: one(users, {
			fields: [organizations.personalOwnerUserId],
			references: [users.id],
		}),
		memberships: many(organizationMembers),
		evidences: many(evidences),
		shareLinks: many(shareLinks),
		invitations: many(organizationInvitations),
		invitationCodes: many(organizationInvitationCodes),
		joinRequests: many(organizationJoinRequests),
		roles: many(organizationRoles),
		activityLogs: many(organizationActivityLogs),
		desktopRecordingSessions: many(desktopRecordingSessions),
	}),
);

export const organizationRolesRelations = relations(
	organizationRoles,
	({ one }) => ({
		organization: one(organizations, {
			fields: [organizationRoles.organizationId],
			references: [organizations.id],
		}),
	}),
);

export const organizationActivityLogsRelations = relations(
	organizationActivityLogs,
	({ one }) => ({
		organization: one(organizations, {
			fields: [organizationActivityLogs.organizationId],
			references: [organizations.id],
		}),
		actor: one(users, {
			fields: [organizationActivityLogs.actorUserId],
			references: [users.id],
		}),
	}),
);

export const organizationJoinRequestsRelations = relations(
	organizationJoinRequests,
	({ one }) => ({
		organization: one(organizations, {
			fields: [organizationJoinRequests.organizationId],
			references: [organizations.id],
		}),
		user: one(users, {
			fields: [organizationJoinRequests.userId],
			references: [users.id],
		}),
		invitationCode: one(organizationInvitationCodes, {
			fields: [organizationJoinRequests.invitationCodeId],
			references: [organizationInvitationCodes.id],
		}),
		reviewer: one(users, {
			fields: [organizationJoinRequests.reviewedBy],
			references: [users.id],
		}),
	}),
);

export const organizationInvitationCodesRelations = relations(
	organizationInvitationCodes,
	({ one }) => ({
		organization: one(organizations, {
			fields: [organizationInvitationCodes.organizationId],
			references: [organizations.id],
		}),
		createdByUser: one(users, {
			fields: [organizationInvitationCodes.createdBy],
			references: [users.id],
		}),
	}),
);

export const organizationInvitationsRelations = relations(
	organizationInvitations,
	({ one }) => ({
		organization: one(organizations, {
			fields: [organizationInvitations.organizationId],
			references: [organizations.id],
		}),
		invitedByUser: one(users, {
			fields: [organizationInvitations.invitedBy],
			references: [users.id],
			relationName: "invitedByUser",
		}),
		acceptedByUser: one(users, {
			fields: [organizationInvitations.acceptedBy],
			references: [users.id],
		}),
	}),
);

export const organizationMembersRelations = relations(
	organizationMembers,
	({ one }) => ({
		organization: one(organizations, {
			fields: [organizationMembers.organizationId],
			references: [organizations.id],
		}),
		user: one(users, {
			fields: [organizationMembers.userId],
			references: [users.id],
		}),
	}),
);

export const provisioningEventsRelations = relations(
	provisioningEvents,
	({ one }) => ({
		user: one(users, {
			fields: [provisioningEvents.userId],
			references: [users.id],
		}),
	}),
);

export const evidencesRelations = relations(evidences, ({ many, one }) => ({
	organization: one(organizations, {
		fields: [evidences.orgId],
		references: [organizations.id],
	}),
	createdByUser: one(users, {
		fields: [evidences.createdBy],
		references: [users.id],
	}),
	artifacts: many(evidenceArtifacts),
	comments: many(evidenceComments),
	shareLinks: many(shareLinks),
	desktopRecordingSession: many(desktopRecordingSessions),
}));

export const evidenceCommentsRelations = relations(
	evidenceComments,
	({ one }) => ({
		evidence: one(evidences, {
			fields: [evidenceComments.evidenceId],
			references: [evidences.id],
		}),
		createdByUser: one(users, {
			fields: [evidenceComments.createdBy],
			references: [users.id],
		}),
	}),
);

export const desktopRecordingSessionsRelations = relations(
	desktopRecordingSessions,
	({ one }) => ({
		evidence: one(evidences, {
			fields: [desktopRecordingSessions.evidenceId],
			references: [evidences.id],
		}),
		organization: one(organizations, {
			fields: [desktopRecordingSessions.orgId],
			references: [organizations.id],
		}),
		createdByUser: one(users, {
			fields: [desktopRecordingSessions.createdBy],
			references: [users.id],
		}),
	}),
);

export const evidenceArtifactsRelations = relations(
	evidenceArtifacts,
	({ one }) => ({
		evidence: one(evidences, {
			fields: [evidenceArtifacts.evidenceId],
			references: [evidences.id],
		}),
	}),
);

export const shareLinksRelations = relations(shareLinks, ({ one }) => ({
	evidence: one(evidences, {
		fields: [shareLinks.evidenceId],
		references: [evidences.id],
	}),
	organization: one(organizations, {
		fields: [shareLinks.orgId],
		references: [organizations.id],
	}),
	createdByUser: one(users, {
		fields: [shareLinks.createdBy],
		references: [users.id],
	}),
}));
