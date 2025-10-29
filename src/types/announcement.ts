export interface AnnouncementSentiment {
    isInteresting: boolean;
    reasoning?: string;
}

export interface Announcement {
    time: string;
    title: string;
    titleUrl: string;
    attachments: { text: string; url: string }[];
    sentiment: AnnouncementSentiment;
}
