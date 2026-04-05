export interface Participant {
  fullName: string;
  nickname: string;
  group: number;
  phone: string;
}

export interface Photo {
  id?: string;
  title: string;
  imageUrl: string;
  submittedBy: string;
  voteCount: number;
}

export interface Vote {
  photoId: string;
  voterName: string;
  voterPhone: string;
  timestamp: FirebaseFirestore.Timestamp;
}

export interface Event {
  id?: string;
  name: string;
  votingCode: string;
  isOpen: boolean;
  createdAt: FirebaseFirestore.Timestamp;
}
