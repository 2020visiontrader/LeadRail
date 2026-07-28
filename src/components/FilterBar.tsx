interface FilterBarProps {
  segments: string[];
  selectedSegment: string;
  onSegmentChange: (segment: string) => void;
}

export default function FilterBar({ segments, selectedSegment, onSegmentChange }: FilterBarProps) {
  return (
    <div className="flex flex-wrap gap-2">
      <button
        onClick={() => onSegmentChange('')}
        className={`px-4 py-2 rounded-lg transition ${
          !selectedSegment ? 'bg-blue-600 text-white' : 'bg-gray-200 hover:bg-gray-300'
        }`}
      >
        All Segments
      </button>
      {segments.map((segment) => (
        <button
          key={segment}
          onClick={() => onSegmentChange(segment)}
          className={`px-4 py-2 rounded-lg capitalize transition ${
            selectedSegment === segment ? 'bg-blue-600 text-white' : 'bg-gray-200 hover:bg-gray-300'
          }`}
        >
          {segment}
        </button>
      ))}
    </div>
  );
}